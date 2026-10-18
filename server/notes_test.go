package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Extra fake API methods for notes: config, uploads, file infos, reactions, conversations.

type upload struct{ channel, name, data string }

var (
	fakeUploads   []upload
	fakeFiles     = map[string]*model.FileInfo{}
	fakeReactions = map[string][]*model.Reaction{}
	fakeMaxFile   int64
)

func (a *folderAPI) GetConfig() *model.Config {
	c := &model.Config{}
	if fakeMaxFile > 0 {
		c.FileSettings.MaxFileSize = model.NewPointer(fakeMaxFile)
	}
	return c
}

func (a *folderAPI) UploadFile(data []byte, channelID, filename string) (*model.FileInfo, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	fi := &model.FileInfo{Id: model.NewId(), ChannelId: channelID, Name: filename, Size: int64(len(data))}
	fakeFiles[fi.Id] = fi
	fakeUploads = append(fakeUploads, upload{channelID, filename, string(data)})
	return fi, nil
}

func (a *folderAPI) GetFile(id string) ([]byte, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, u := range fakeUploads {
		if fi, ok := fakeFiles[id]; ok && fi.Name == u.name {
			return []byte(u.data), nil
		}
	}
	return nil, model.NewAppError("GetFile", "not found", nil, "", http.StatusNotFound)
}

func (a *folderAPI) GetFileInfo(id string) (*model.FileInfo, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if fi, ok := fakeFiles[id]; ok {
		return fi, nil
	}
	return nil, model.NewAppError("GetFileInfo", "not found", nil, "", http.StatusNotFound)
}

func (a *folderAPI) GetReactions(postID string) ([]*model.Reaction, *model.AppError) {
	return fakeReactions[postID], nil
}

func (a *folderAPI) GetDirectChannel(u1, u2 string) (*model.Channel, *model.AppError) {
	ids := []string{u1, u2}
	sort.Strings(ids)
	return &model.Channel{Id: "dm:" + strings.Join(ids, ":"), Type: model.ChannelTypeDirect}, nil
}

func (a *folderAPI) GetGroupChannel(ids []string) (*model.Channel, *model.AppError) {
	s := append([]string{}, ids...)
	sort.Strings(s)
	return &model.Channel{Id: "gm:" + strings.Join(s, ":"), Type: model.ChannelTypeGroup}, nil
}

func resetNoteFakes() {
	fakeUploads = nil
	fakeFiles = map[string]*model.FileInfo{}
	fakeReactions = map[string][]*model.Reaction{}
	fakeMaxFile = 0
}

func dmID(a, b string) string {
	ids := []string{a, b}
	sort.Strings(ids)
	return "dm:" + strings.Join(ids, ":")
}

// postNote sends a multipart note with text and files (name → content).
func postNote(t *testing.T, f *folderFixture, fid, uid, text string, files map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("text", text))
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fw, err := mw.CreateFormFile("files", n)
		require.NoError(t, err)
		_, _ = fw.Write([]byte(files[n]))
	}
	require.NoError(t, mw.Close())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/folders/"+fid+"/notes", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Mattermost-User-Id", uid)
	w := httptest.NewRecorder()
	f.p.ServeHTTP(nil, w, req)
	return w
}

func folderItems(t *testing.T, f *folderFixture, fid, uid string) []map[string]any {
	t.Helper()
	w := f.call(t, http.MethodGet, "/api/v1/folders/"+fid, "", uid)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out []map[string]any
	for _, x := range decode(t, w)["items"].([]any) {
		out = append(out, x.(map[string]any))
	}
	return out
}

func TestNoteWithFilesIsStoredInTheFolderConversationOnly(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)

	w := postNote(t, f, fid, f.alice, "اسکریپت پشتیبان‌گیری", map[string]string{"backup.sql": "BACKUP DATABASE x;", "notes.txt": "hi"})
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Len(t, fakeUploads, 2)
	for _, u := range fakeUploads {
		assert.Equal(t, dmID(f.alice, f.bob), u.channel, "files go to the DM of the two members")
	}

	items := folderItems(t, f, fid, f.bob)
	require.Len(t, items, 1)
	it := items[0]
	assert.Equal(t, "note", it["kind"])
	assert.Equal(t, "اسکریپت پشتیبان‌گیری", it["message"])
	assert.Equal(t, f.alice, it["user_id"])
	assert.Len(t, it["files"], 2)
	assert.Empty(t, it["reactions"])
	assert.NotContains(t, it, "post_id", "a note is not a conversation message")
}

func TestNoteStorageChannelPerFolderKind(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	personal := idOf(f.create(t, f.alice, `{"kind":"personal","name":"p"}`))
	require.Equal(t, http.StatusCreated, postNote(t, f, personal, f.alice, "", map[string]string{"a.txt": "a"}).Code)
	assert.Equal(t, dmID(f.alice, f.alice), fakeUploads[0].channel, "personal: the author's own conversation")

	group := idOf(f.create(t, f.alice, `{"kind":"group","name":"g","member_ids":["`+f.bob+`","`+f.carol+`"]}`))
	f.call(t, http.MethodPost, "/api/v1/folders/"+group+"/approve", "", f.bob)
	f.call(t, http.MethodPost, "/api/v1/folders/"+group+"/approve", "", f.carol)
	require.Equal(t, http.StatusCreated, postNote(t, f, group, f.carol, "", map[string]string{"b.txt": "b"}).Code)
	members := []string{f.alice, f.bob, f.carol}
	sort.Strings(members)
	assert.Equal(t, "gm:"+strings.Join(members, ":"), fakeUploads[1].channel, "group: the group message of all members")

	w := f.call(t, http.MethodPost, "/api/v1/folders/"+group+"/conversation", "", f.bob)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "gm:"+strings.Join(members, ":"), decode(t, w)["channel_id"])
}

func TestNoteReactionsStayInTheFolder(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)
	nid := decode(t, postNote(t, f, fid, f.alice, "سلام", nil))["id"].(string)
	react := func(uid, emoji string) *httptest.ResponseRecorder {
		return f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/notes/"+nid+"/reactions", `{"emoji_name":"`+emoji+`"}`, uid)
	}

	require.Equal(t, http.StatusOK, react(f.bob, "+1").Code)
	require.Equal(t, http.StatusOK, react(f.bob, "+1").Code, "adding twice is a no-op")
	require.Equal(t, http.StatusOK, react(f.alice, "+1").Code)
	items := folderItems(t, f, fid, f.alice)
	assert.Equal(t, map[string]any{"+1": []any{f.bob, f.alice}}, items[0]["reactions"])

	w := f.call(t, http.MethodDelete, "/api/v1/folders/"+fid+"/notes/"+nid+"/reactions/+1", "", f.bob)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, map[string]any{"+1": []any{f.alice}}, decode(t, w)["reactions"])

	assert.Equal(t, http.StatusBadRequest, react(f.bob, "<script>").Code)
	assert.Equal(t, http.StatusNotFound, react(f.carol, "heart").Code, "non-members can't react")

	other := idOf(f.create(t, f.alice, `{"kind":"personal","name":"x"}`))
	w = f.call(t, http.MethodPost, "/api/v1/folders/"+other+"/notes/"+nid+"/reactions", `{"emoji_name":"heart"}`, f.alice)
	assert.Equal(t, http.StatusNotFound, w.Code, "a note can't be reached through another folder")
}

func TestRemovingANoteDeletesItAndDeletingTheFolderDeletesNotes(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	fid := idOf(f.create(t, f.alice, `{"kind":"personal","name":"x"}`))
	n1 := decode(t, postNote(t, f, fid, f.alice, "one", nil))["id"].(string)
	n2 := decode(t, postNote(t, f, fid, f.alice, "two", nil))["id"].(string)

	require.Equal(t, http.StatusOK, f.call(t, http.MethodDelete, "/api/v1/folders/"+fid+"/items/"+n1, "", f.alice).Code)
	assert.Empty(t, f.api.kv[keyNote(n1)], "note document deleted")
	assert.Len(t, folderItems(t, f, fid, f.alice), 1)

	f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/delete-request", "", f.alice)
	assert.Empty(t, f.api.kv[keyNote(n2)], "deleting the folder deletes its notes")
}

func TestSavedMessageShowsItsFilesAndMattermostReactions(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)
	fi := &model.FileInfo{Id: model.NewId(), Name: "plan.pdf", Extension: "pdf", Size: 10}
	fakeFiles[fi.Id] = fi
	f.api.posts[f.post].FileIds = model.StringArray{fi.Id}
	f.api.posts[f.post].HasReactions = true
	fakeReactions[f.post] = []*model.Reaction{{UserId: f.bob, PostId: f.post, EmojiName: "heart"}}
	require.Equal(t, http.StatusOK, f.call(t, http.MethodPost, "/api/v1/folders/"+fid+"/items", `{"post_id":"`+f.post+`"}`, f.alice).Code)

	it := folderItems(t, f, fid, f.alice)[0]
	assert.Equal(t, "post", it["kind"])
	assert.Equal(t, f.post, it["id"])
	require.Len(t, it["files"], 1)
	assert.Equal(t, "plan.pdf", it["files"].([]any)[0].(map[string]any)["name"])
	assert.Equal(t, map[string]any{"heart": []any{f.bob}}, it["reactions"])
}

func TestNoteValidation(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)

	assert.Equal(t, http.StatusBadRequest, postNote(t, f, fid, f.alice, "   ", nil).Code, "empty note")
	many := map[string]string{}
	for i := 0; i <= noteFilesMax; i++ {
		many[string(rune('a'+i))+".txt"] = "x"
	}
	assert.Equal(t, http.StatusBadRequest, postNote(t, f, fid, f.alice, "x", many).Code, "too many files")
	assert.Equal(t, http.StatusBadRequest, postNote(t, f, fid, f.alice, strings.Repeat("ج", noteTextMax+1), nil).Code, "text too long")

	fakeMaxFile = 4
	assert.Equal(t, http.StatusUnprocessableEntity, postNote(t, f, fid, f.alice, "x", map[string]string{"big.bin": "12345"}).Code, "file over the server limit")
	fakeMaxFile = 0

	assert.Equal(t, http.StatusNotFound, postNote(t, f, fid, f.carol, "x", nil).Code, "non-member")
	pending := idOf(f.create(t, f.alice, `{"kind":"shared","name":"p","member_ids":["`+f.carol+`"]}`))
	assert.Equal(t, http.StatusConflict, postNote(t, f, pending, f.alice, "x", nil).Code, "folder not active yet")
	assert.Empty(t, fakeUploads, "nothing uploaded for rejected notes")
}

func TestCleanFileName(t *testing.T) {
	assert.Equal(t, "passwd", cleanFileName("../../etc/passwd"))
	assert.Equal(t, "evil.txt", cleanFileName(`C:\temp\evil.txt`))
	assert.Equal(t, "file", cleanFileName("  "))
}

func TestNoteFilesAreServedToFolderMembersOnly(t *testing.T) {
	resetNoteFakes()
	f := newFolderFixture(t)
	fid := sharedWithBob(t, f)
	require.Equal(t, http.StatusCreated, postNote(t, f, fid, f.alice, "", map[string]string{"page.html": "<script>x</script>", "pic.png": "PNG"}).Code)
	it := folderItems(t, f, fid, f.bob)[0]
	nid := it["id"].(string)
	ids := map[string]string{}
	for _, x := range it["files"].([]any) {
		fv := x.(map[string]any)
		ids[fv["name"].(string)] = fv["id"].(string)
	}
	for id, fi := range fakeFiles {
		if fi.Name == "pic.png" {
			fakeFiles[id].MimeType = "image/png"
		} else {
			fakeFiles[id].MimeType = "text/html"
		}
	}
	get := func(uid, file, query string) *httptest.ResponseRecorder {
		return f.call(t, http.MethodGet, "/api/v1/folders/"+fid+"/notes/"+nid+"/files/"+file+query, "", uid)
	}

	w := get(f.bob, ids["page.html"], "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, "<script>x</script>", w.Body.String())
	assert.Equal(t, "application/octet-stream", w.Header().Get("Content-Type"), "HTML is never rendered as a page")
	assert.Contains(t, w.Header().Get("Content-Disposition"), "attachment")
	assert.Equal(t, "nosniff", w.Header().Get("X-Content-Type-Options"))

	w = get(f.alice, ids["pic.png"], "")
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "image/png", w.Header().Get("Content-Type"))
	assert.Contains(t, w.Header().Get("Content-Disposition"), "inline")
	assert.Contains(t, get(f.alice, ids["pic.png"], "?download=1").Header().Get("Content-Disposition"), "attachment")

	assert.Equal(t, http.StatusNotFound, get(f.carol, ids["pic.png"], "").Code, "not a member")
	assert.Equal(t, http.StatusNotFound, get(f.bob, model.NewId(), "").Code, "not a file of this note")
}
