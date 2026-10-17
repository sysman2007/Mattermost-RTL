package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// folderAPI is an in-memory plugin API. Only the methods the folder code
// uses are implemented; the embedded mock covers the rest.
type folderAPI struct {
	*plugintest.API
	mu           sync.Mutex
	kv           map[string][]byte
	users        map[string]*model.User
	posts        map[string]*model.Post
	canRead      map[string]bool // "<user>|<channel>"
	rejectAtomic int             // next N atomic writes are refused (simulated conflicts)
	failUsers    bool            // GetUser returns a server error
	writes       int             // successful KVSetWithOptions calls
	permChecks   int             // HasPermissionToChannel calls
}

func newFolderAPI() *folderAPI {
	return &folderAPI{
		API:     &plugintest.API{},
		kv:      map[string][]byte{},
		users:   map[string]*model.User{},
		posts:   map[string]*model.Post{},
		canRead: map[string]bool{},
	}
}

func (a *folderAPI) KVGet(key string) ([]byte, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	v, ok := a.kv[key]
	if !ok {
		return nil, nil
	}
	return append([]byte(nil), v...), nil
}

func (a *folderAPI) KVSet(key string, value []byte) *model.AppError {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.kv[key] = append([]byte(nil), value...)
	return nil
}

// KVSetWithOptions implements the Atomic compare exactly as the server does:
// the write happens only if the stored bytes equal OldValue (absent == nil).
func (a *folderAPI) KVSetWithOptions(key string, value []byte, opts model.PluginKVSetOptions) (bool, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if opts.Atomic {
		if a.rejectAtomic > 0 {
			a.rejectAtomic--
			return false, nil
		}
		cur, ok := a.kv[key]
		if !ok {
			cur = nil
		}
		if !bytes.Equal(cur, opts.OldValue) {
			return false, nil
		}
	}
	a.kv[key] = append([]byte(nil), value...)
	a.writes++
	return true, nil
}

func (a *folderAPI) KVDelete(key string) *model.AppError {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.kv, key)
	return nil
}

func (a *folderAPI) GetUser(id string) (*model.User, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failUsers {
		return nil, model.NewAppError("GetUser", "db down", nil, "", http.StatusInternalServerError)
	}
	u, ok := a.users[id]
	if !ok {
		return nil, model.NewAppError("GetUser", "not found", nil, "", http.StatusNotFound)
	}
	return u, nil
}

func (a *folderAPI) GetPost(id string) (*model.Post, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.posts[id]
	if !ok {
		return nil, model.NewAppError("GetPost", "not found", nil, "", http.StatusNotFound)
	}
	return p, nil
}

func (a *folderAPI) HasPermissionToChannel(userID, channelID string, _ *model.Permission) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.permChecks++
	return a.canRead[userID+"|"+channelID]
}

func (a *folderAPI) LogInfo(string, ...any)  {}
func (a *folderAPI) LogWarn(string, ...any)  {}
func (a *folderAPI) LogError(string, ...any) {}

type folderFixture struct {
	p     *Plugin
	api   *folderAPI
	alice string
	bob   string
	carol string
	chA   string // channel alice and bob can read
	chB   string // channel only alice can read
	post  string // alice's post in chA
	other string // post in chB
}

func newFolderFixture(t *testing.T) *folderFixture {
	t.Helper()
	api := newFolderAPI()
	f := &folderFixture{
		api:   api,
		alice: model.NewId(), bob: model.NewId(), carol: model.NewId(),
		chA: model.NewId(), chB: model.NewId(),
		post: model.NewId(), other: model.NewId(),
	}
	for _, id := range []string{f.alice, f.bob, f.carol} {
		api.users[id] = &model.User{Id: id}
	}
	api.posts[f.post] = &model.Post{Id: f.post, ChannelId: f.chA, UserId: f.alice, Message: "SELECT 1;"}
	api.posts[f.other] = &model.Post{Id: f.other, ChannelId: f.chB, UserId: f.alice, Message: "secret"}
	api.canRead[f.alice+"|"+f.chA] = true
	api.canRead[f.bob+"|"+f.chA] = true
	api.canRead[f.alice+"|"+f.chB] = true
	api.canRead[f.carol+"|"+f.chA] = true

	p := &Plugin{}
	p.SetAPI(api)
	require.NoError(t, p.OnActivate())
	p.config = configuration{EnableSharedFolders: true}.normalized()
	f.p = p
	t.Cleanup(func() { foldersNow = func() int64 { return model.GetMillis() } })
	return f
}

func (f *folderFixture) call(t *testing.T, method, path, body, uid string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Mattermost-User-Id", uid)
	w := httptest.NewRecorder()
	f.p.ServeHTTP(nil, w, req)
	return w
}

func (f *folderFixture) create(t *testing.T, uid, body string) map[string]any {
	t.Helper()
	w := f.call(t, http.MethodPost, "/api/v1/folders", body, uid)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	return decode(t, w)
}

func idOf(m map[string]any) string { return m["id"].(string) }

func listIDs(t *testing.T, f *folderFixture, uid string) []string {
	t.Helper()
	w := f.call(t, http.MethodGet, "/api/v1/folders", "", uid)
	require.Equal(t, http.StatusOK, w.Code)
	var out []string
	for _, x := range decode(t, w)["folders"].([]any) {
		out = append(out, x.(map[string]any)["id"].(string))
	}
	return out
}

func TestFoldersDisabledByDefault(t *testing.T) {
	f := newFolderFixture(t)
	f.p.config = configuration{}.normalized()
	w := f.call(t, http.MethodGet, "/api/v1/folders", "", f.alice)
	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "disabled")
}

func TestPersonalFolderLifecycle(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"personal","name":"اسکریپت‌ها"}`))

	assert.Equal(t, []string{fid}, listIDs(t, f, f.alice))
	assert.Empty(t, listIDs(t, f, f.bob), "other users never see personal folders")

	// Own post in a readable channel: accepted, and a duplicate is a no-op.
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)

	// A post in a channel alice can't read is reported exactly like a missing post.
	w := f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+model.NewId()+`"}`, f.alice)
	assert.Equal(t, http.StatusNotFound, w.Code)

	w = f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	require.Equal(t, http.StatusOK, w.Code)
	items := decode(t, w)["items"].([]any)
	require.Len(t, items, 1)
	assert.Equal(t, "SELECT 1;", items[0].(map[string]any)["message"])

	require.Equal(t, http.StatusOK, f.call(t, http.MethodDelete, "/api/v1/folders/"+fid+"/items/"+f.post, "", f.alice).Code)
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodDelete, "/api/v1/folders/"+fid+"/items/"+f.post, "", f.alice).Code)

	assert.Equal(t, true, decode(t, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/delete-request", "", f.alice))["deleted"])
	assert.Empty(t, listIDs(t, f, f.alice))
	assert.Empty(t, f.api.kv[keyFolder(fid)], "folder document removed")
}

func TestContactFolderIsPrivateToOwner(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"contact","name":"با بابک","contact_user_id":"`+f.bob+`"}`))

	assert.Equal(t, []string{fid}, listIDs(t, f, f.alice))
	assert.Empty(t, listIDs(t, f, f.bob), "the contact can't see the folder")
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.bob).Code)
}

func TestSharedFolderNeedsApprovalAndAddsItemsAfterwards(t *testing.T) {
	f := newFolderFixture(t)
	created := f.create(t, f.alice, `{"kind":"shared","name":"دیتابیس","member_ids":["`+f.bob+`"]}`)
	fid := idOf(created)
	assert.Equal(t, "pending", created["status"])

	// Nothing can be added until the invitee accepts.
	assert.Equal(t, http.StatusConflict, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)

	// The invitee sees it as an invitation, without items.
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.bob)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "invitee", decode(t, w)["folder"].(map[string]any)["role"])
	assert.Empty(t, decode(t, w)["items"])

	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.bob).Code)
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)

	w = f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.bob)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Len(t, decode(t, w)["items"], 1, "both members see the shared item")

	// A stranger gets the same 404 as a folder that doesn't exist.
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.carol).Code)
}

func TestSharedDeleteNeedsEveryMemberToApprove(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"shared","name":"x","member_ids":["`+f.bob+`"]}`))
	f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.bob)

	w := f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/delete-request", "", f.alice)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, false, decode(t, w)["deleted"])

	// A rejection stops the deletion and keeps the folder.
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/delete-request/reject", "", f.bob).Code)
	w = f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	assert.Equal(t, "active", decode(t, w)["folder"].(map[string]any)["status"])

	f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/delete-request", "", f.alice)
	w = f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/delete-request/approve", "", f.bob)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, true, decode(t, w)["deleted"])
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice).Code)
	assert.Empty(t, listIDs(t, f, f.bob))
}

func TestGroupFolderNeedsEveryInvitee(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"group","name":"تیم","member_ids":["`+f.bob+`","`+f.carol+`"]}`))

	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.bob).Code)
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	assert.Equal(t, "pending", decode(t, w)["folder"].(map[string]any)["status"], "still waiting for carol")

	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.carol).Code)
	w = f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	assert.Equal(t, "active", decode(t, w)["folder"].(map[string]any)["status"])
}

func TestGroupSizeIsCapped(t *testing.T) {
	f := newFolderFixture(t)
	var ids []string
	for i := 0; i < folderGroupMax; i++ { // 8 others + owner = 9 > 8
		ids = append(ids, model.NewId())
	}
	body, _ := json.Marshal(map[string]any{"kind": "group", "name": "big", "member_ids": ids})
	w := f.call(t, http.MethodPost, "/api/v1/folders", string(body), f.alice)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRejectedCreationRemovesTheFolder(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"shared","name":"x","member_ids":["`+f.bob+`"]}`))
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/reject", "", f.bob).Code)
	assert.Empty(t, listIDs(t, f, f.alice))
	assert.Empty(t, listIDs(t, f, f.bob))
}

func TestLeavingTransfersOwnershipAndLastLeaverDeletes(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"shared","name":"x","member_ids":["`+f.bob+`"]}`))
	f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.bob)

	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/leave", "", f.alice).Code)
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.bob)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, f.bob, decode(t, w)["folder"].(map[string]any)["owner"])
	assert.Empty(t, listIDs(t, f, f.alice))

	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/leave", "", f.bob).Code)
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.bob).Code)
}

func TestPendingCreationExpires(t *testing.T) {
	f := newFolderFixture(t)
	now := model.GetMillis()
	foldersNow = func() int64 { return now }
	fid := idOf(f.create(t, f.alice, `{"kind":"shared","name":"x","member_ids":["`+f.bob+`"]}`))

	foldersNow = func() int64 { return now + int64(folderRequestTTL/time.Millisecond) + 1 }
	assert.Empty(t, listIDs(t, f, f.alice))
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice).Code)
	assert.Empty(t, listIDs(t, f, f.bob))
}

func TestDeactivatedMemberIsRemoved(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"shared","name":"x","member_ids":["`+f.bob+`"]}`))
	f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.bob)

	f.api.users[f.bob].DeleteAt = model.GetMillis()
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, []any{f.alice}, decode(t, w)["folder"].(map[string]any)["members"])
	assert.Empty(t, listIDs(t, f, f.bob))
}

func TestCompareAndSetRetriesThenGivesUp(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"personal","name":"x"}`))

	f.api.rejectAtomic = 2 // two conflicts, the third attempt succeeds
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)

	f.api.rejectAtomic = folderCASAttempts // every attempt conflicts
	w := f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.other+`"}`, f.alice)
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	f.api.rejectAtomic = 0
}

func TestBadRequests(t *testing.T) {
	f := newFolderFixture(t)
	for _, body := range []string{
		`{"kind":"personal","name":"   "}`,
		`{"kind":"nope","name":"x"}`,
		`{"kind":"contact","name":"x","contact_user_id":"` + f.alice + `"}`,
		`{"kind":"shared","name":"x","member_ids":[]}`,
		`{"kind":"shared","name":"x","member_ids":["bad-id"]}`,
		`{"kind":"personal","name":"` + strings.Repeat("ج", folderNameMax+1) + `"}`,
	} {
		assert.Equal(t, http.StatusBadRequest, f.call(t, http.MethodPost, "/api/v1/folders", body, f.alice).Code, body)
	}
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodGet, "/api/v1/folders/not-an-id", "", f.alice).Code)
}

func sharedWithBob(t *testing.T, f *folderFixture) string {
	t.Helper()
	fid := idOf(f.create(t, f.alice, `{"kind":"shared","name":"x","member_ids":["`+f.bob+`"]}`))
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/approve", "", f.bob).Code)
	return fid
}

func storedItems(t *testing.T, f *folderFixture, fid string) []folderItem {
	t.Helper()
	var items []folderItem
	if raw := f.api.kv[keyItems(fid)]; len(raw) > 0 {
		require.NoError(t, json.Unmarshal(raw, &items))
	}
	return items
}

func TestUserMissingFromDatabaseDoesNotLockTheFolder(t *testing.T) {
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)

	delete(f.api.users, f.bob) // GetUser now returns 404, not a deactivated user
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, []any{f.alice}, decode(t, w)["folder"].(map[string]any)["members"])
}

func TestUserLookupFailureIsAServerError(t *testing.T) {
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)

	f.api.failUsers = true
	assert.Equal(t, http.StatusInternalServerError, f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice).Code,
		"a failed lookup must not be treated as a removed member")
	w := f.call(t, http.MethodPost, "/api/v1/folders", `{"kind":"contact","name":"x","contact_user_id":"`+f.bob+`"}`, f.alice)
	assert.Equal(t, http.StatusInternalServerError, w.Code, "not reported as a bad request")
	f.api.failUsers = false
	w = f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	assert.Len(t, decode(t, w)["folder"].(map[string]any)["members"], 2, "nobody was removed")
}

func TestDeletedPostsAreRemovedAndFreeCapacity(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"personal","name":"x"}`))
	gone := model.NewId()
	f.api.posts[gone] = &model.Post{Id: gone, ChannelId: f.chA, Message: "old"}
	for _, id := range []string{f.post, gone} {
		require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+id+`"}`, f.alice).Code)
	}
	require.Len(t, storedItems(t, f, fid), 2)

	f.api.posts[gone].DeleteAt = model.GetMillis()
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Len(t, decode(t, w)["items"], 1)
	stored := storedItems(t, f, fid)
	require.Len(t, stored, 1, "the deleted post no longer takes a slot")
	assert.Equal(t, f.post, stored[0].PostID)

	delete(f.api.posts, f.post) // a post missing entirely is removed too
	f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	assert.Empty(t, storedItems(t, f, fid))
}

func TestItemsHiddenFromOneMemberAreKeptForOthers(t *testing.T) {
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.other+`"}`, f.alice).Code)

	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.bob) // bob can't read chB
	assert.Empty(t, decode(t, w)["items"])
	assert.Len(t, storedItems(t, f, fid), 1, "hidden from bob, not removed")
	w = f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	assert.Len(t, decode(t, w)["items"], 1)
}

func TestNoWriteWhenNothingChanges(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"personal","name":"x"}`))
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)

	before := f.api.writes
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)
	assert.Equal(t, http.StatusNotFound, f.call(t, http.MethodDelete, "/api/v1/folders/"+fid+"/items/"+model.NewId(), "", f.alice).Code)
	assert.Equal(t, before, f.api.writes, "duplicate add and missing remove don't write")
}

func TestReadPermissionIsCheckedOncePerChannel(t *testing.T) {
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"personal","name":"x"}`))
	for i := 0; i < 5; i++ {
		id := model.NewId()
		f.api.posts[id] = &model.Post{Id: id, ChannelId: f.chA, Message: "m"}
		require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+id+`"}`, f.alice).Code)
	}
	f.api.permChecks = 0
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", f.alice)
	require.Len(t, decode(t, w)["items"], 5)
	assert.Equal(t, 1, f.api.permChecks)
}
