package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
)

// Shared message folders («پوشه‌ها»). A folder is a list of message IDs with
// a name; it never stores message text. Four kinds:
//   - personal: visible to its owner only;
//   - contact:  owner only, linked to one contact (the contact sees nothing);
//   - shared:   owner + one other user; creation and deletion need that user's approval;
//   - group:    owner + up to 7 others (folderGroupMax in total); creation and
//     deletion need every invitee's / member's approval.
//
// Storage is the plugin KV store. A folder is one JSON document; its items are
// a second document. Every update is a compare-and-set on the stored bytes
// (see casKV), so two users editing the same folder can't overwrite each other.
// Keys are prefix + ID, so they stay well under the KV key-length limit.

const (
	folderKindPersonal = "personal"
	folderKindContact  = "contact"
	folderKindShared   = "shared"
	folderKindGroup    = "group"

	folderActive   = "active"
	folderPending  = "pending"  // waiting for invitees to approve creation
	folderDeleting = "deleting" // waiting for members to approve deletion

	foldersPerUser      = 200
	itemsPerFolder      = 500
	pendingPerUser      = 20
	folderNameMax       = 60
	folderRequestTTL    = 7 * 24 * time.Hour
	folderCASAttempts   = 3
	folderGroupMax      = model.ChannelGroupMaxUsers
	folderSharedOthers  = 1
	folderGroupMinOther = 2
)

// foldersNow is a variable so tests can move time (expiry).
var foldersNow = func() int64 { return model.GetMillis() }

type folderMeta struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Owner     string   `json:"owner"`
	Contact   string   `json:"contact,omitempty"`
	Members   []string `json:"members"`            // active members, owner included
	Invitees  []string `json:"invitees,omitempty"` // not yet approved (creation)
	Status    string   `json:"status"`
	DeleteBy  string   `json:"delete_by,omitempty"` // who asked for deletion
	DeleteOK  []string `json:"delete_ok,omitempty"` // members who approved deletion
	ExpiresAt int64    `json:"expires_at,omitempty"`
	CreatedAt int64    `json:"created_at"`
}

type folderItem struct {
	PostID    string `json:"post_id"`
	ChannelID string `json:"channel_id"`
	AddedBy   string `json:"added_by"`
	AddedAt   int64  `json:"added_at"`
}

// folderError carries the HTTP status and the machine-readable code.
type folderError struct {
	status int
	code   string
}

func (e *folderError) Error() string { return e.code }

var (
	errFolderBadRequest = &folderError{http.StatusBadRequest, "bad_request"}
	errFolderNotFound   = &folderError{http.StatusNotFound, "not_found"}
	errFolderForbidden  = &folderError{http.StatusForbidden, "forbidden"}
	errFolderState      = &folderError{http.StatusConflict, "invalid_state"}
	errFolderLimit      = &folderError{http.StatusUnprocessableEntity, "limit_reached"}
	errFolderBusy       = &folderError{http.StatusServiceUnavailable, "busy"}
	errFolderStore      = &folderError{http.StatusInternalServerError, "store_failed"}

	// errNoChange tells casKV that nothing needs writing; it is not an API error.
	errNoChange = errors.New("no change")
)

func writeFolderError(w http.ResponseWriter, err error) {
	var fe *folderError
	if errors.As(err, &fe) {
		writeError(w, fe.status, fe.code)
		return
	}
	writeError(w, http.StatusInternalServerError, "store_failed")
}

func keyFolder(fid string) string { return "fo_" + fid }
func keyItems(fid string) string  { return "fx_" + fid }
func keyUser(uid string) string   { return "fu_" + uid }

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func removeFrom(list []string, v string) []string {
	out := make([]string, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

// casKV reads key, lets mutate build the next value from the stored bytes and
// writes it only if the stored bytes are still the same. Retries a few times.
func (p *Plugin) casKV(key string, mutate func(old []byte) ([]byte, error)) error {
	for attempt := 0; attempt < folderCASAttempts; attempt++ {
		old, appErr := p.API.KVGet(key)
		if appErr != nil {
			p.API.LogError("folders: read failed", "key", key, "error", appErr.Error())
			return errFolderStore
		}
		next, err := mutate(old)
		if errors.Is(err, errNoChange) {
			return nil
		}
		if err != nil {
			return err
		}
		ok, appErr := p.API.KVSetWithOptions(key, next, model.PluginKVSetOptions{Atomic: true, OldValue: old})
		if appErr != nil {
			p.API.LogError("folders: write failed", "key", key, "error", appErr.Error())
			return errFolderStore
		}
		if ok {
			return nil
		}
	}
	return errFolderBusy
}

func (p *Plugin) readFolder(fid string) (*folderMeta, error) {
	raw, appErr := p.API.KVGet(keyFolder(fid))
	if appErr != nil {
		p.API.LogError("folders: read failed", "folder_id", fid, "error", appErr.Error())
		return nil, errFolderStore
	}
	if len(raw) == 0 {
		return nil, errFolderNotFound
	}
	var f folderMeta
	if err := json.Unmarshal(raw, &f); err != nil {
		p.API.LogError("folders: corrupt folder document", "folder_id", fid)
		return nil, errFolderStore
	}
	return &f, nil
}

// updateFolder applies fn to the stored folder atomically.
func (p *Plugin) updateFolder(fid string, fn func(f *folderMeta) error) (*folderMeta, error) {
	var out *folderMeta
	err := p.casKV(keyFolder(fid), func(old []byte) ([]byte, error) {
		if len(old) == 0 {
			return nil, errFolderNotFound
		}
		var f folderMeta
		if err := json.Unmarshal(old, &f); err != nil {
			return nil, errFolderStore
		}
		if err := fn(&f); err != nil {
			return nil, err
		}
		b, err := json.Marshal(f)
		if err != nil {
			return nil, errFolderStore
		}
		out = &f
		return b, nil
	})
	return out, err
}

// userFolders returns the folder IDs in a user's index.
func (p *Plugin) userFolders(uid string) ([]string, error) {
	raw, appErr := p.API.KVGet(keyUser(uid))
	if appErr != nil {
		return nil, errFolderStore
	}
	var ids []string
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &ids); err != nil {
			return nil, errFolderStore
		}
	}
	return ids, nil
}

func (p *Plugin) updateUserFolders(uid string, fn func(ids []string) ([]string, error)) error {
	return p.casKV(keyUser(uid), func(old []byte) ([]byte, error) {
		var ids []string
		if len(old) > 0 {
			if err := json.Unmarshal(old, &ids); err != nil {
				return nil, errFolderStore
			}
		}
		next, err := fn(ids)
		if err != nil {
			return nil, err
		}
		if next == nil {
			next = []string{}
		}
		b, err := json.Marshal(next)
		if err != nil {
			return nil, errFolderStore
		}
		return b, nil
	})
}

func (p *Plugin) addToIndex(uid, fid string) error {
	return p.updateUserFolders(uid, func(ids []string) ([]string, error) {
		if contains(ids, fid) {
			return ids, nil
		}
		if len(ids) >= foldersPerUser {
			return nil, errFolderLimit
		}
		return append(ids, fid), nil
	})
}

func (p *Plugin) removeFromIndex(uid, fid string) {
	err := p.updateUserFolders(uid, func(ids []string) ([]string, error) {
		return removeFrom(ids, fid), nil
	})
	if err != nil {
		p.API.LogWarn("folders: could not update user index", "user_id", uid, "folder_id", fid)
	}
}

// deleteFolder removes the folder, its items and every index entry.
func (p *Plugin) deleteFolder(f *folderMeta) error {
	if appErr := p.API.KVDelete(keyFolder(f.ID)); appErr != nil {
		p.API.LogError("folders: delete failed", "folder_id", f.ID, "error", appErr.Error())
		return errFolderStore
	}
	if appErr := p.API.KVDelete(keyItems(f.ID)); appErr != nil {
		p.API.LogWarn("folders: could not delete items", "folder_id", f.ID)
	}
	for _, uid := range append(append([]string{}, f.Members...), f.Invitees...) {
		p.removeFromIndex(uid, f.ID)
	}
	return nil
}

// requireHuman rejects unknown, deactivated or bot users as folder members.
func (p *Plugin) requireHuman(uid string) error {
	u, appErr := p.API.GetUser(uid)
	if appErr != nil && appErr.StatusCode != http.StatusNotFound {
		p.API.LogError("folders: user lookup failed", "user_id", uid, "error", appErr.Error())
		return errFolderStore
	}
	if appErr != nil || u == nil || u.DeleteAt != 0 || u.IsBot {
		return errFolderBadRequest
	}
	return nil
}

// pendingInvites counts creation requests waiting for uid (bounds spam).
func (p *Plugin) pendingInvites(uid string) (int, error) {
	ids, err := p.userFolders(uid)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		f, err := p.readFolder(id)
		if err != nil {
			continue
		}
		if f.Status == folderPending && contains(f.Invitees, uid) {
			n++
		}
	}
	return n, nil
}

// lifecycle applies time-based rules and removes deactivated users. It returns
// errFolderNotFound if the folder no longer exists after that.
func (p *Plugin) lifecycle(f *folderMeta) (*folderMeta, error) {
	if f.ExpiresAt > 0 && foldersNow() >= f.ExpiresAt {
		switch f.Status {
		case folderPending:
			if err := p.deleteFolder(f); err != nil {
				return nil, err
			}
			return nil, errFolderNotFound
		case folderDeleting:
			// A deletion nobody approved in time is cancelled, not the folder.
			updated, err := p.updateFolder(f.ID, func(x *folderMeta) error {
				x.Status, x.DeleteBy, x.DeleteOK, x.ExpiresAt = folderActive, "", nil, 0
				return nil
			})
			if err != nil {
				return nil, err
			}
			f = updated
		}
	}
	if f.Kind == folderKindShared || f.Kind == folderKindGroup {
		return p.pruneDeactivated(f)
	}
	return f, nil
}

func (p *Plugin) pruneDeactivated(f *folderMeta) (*folderMeta, error) {
	var dead []string
	for _, uid := range append(append([]string{}, f.Members...), f.Invitees...) {
		u, appErr := p.API.GetUser(uid)
		if appErr != nil && appErr.StatusCode != http.StatusNotFound {
			p.API.LogError("folders: user lookup failed", "user_id", uid, "error", appErr.Error())
			return nil, errFolderStore
		}
		if appErr != nil || u == nil || u.DeleteAt != 0 || u.IsBot {
			dead = append(dead, uid)
		}
	}
	if len(dead) == 0 {
		return f, nil
	}
	updated, err := p.updateFolder(f.ID, func(x *folderMeta) error {
		for _, d := range dead {
			x.Members = removeFrom(x.Members, d)
			x.Invitees = removeFrom(x.Invitees, d)
			x.DeleteOK = removeFrom(x.DeleteOK, d)
			if x.DeleteBy == d {
				x.DeleteBy = ""
			}
		}
		if contains(dead, x.Owner) && len(x.Members) > 0 {
			x.Owner = x.Members[0] // ownership goes to the first remaining member
		}
		if len(x.Members) == 0 {
			return nil // handled below: nobody left, the folder goes
		}
		if x.Status == folderPending && len(x.Invitees) == 0 {
			x.Status, x.ExpiresAt = folderActive, 0
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, d := range dead {
		p.removeFromIndex(d, f.ID)
	}
	if len(updated.Members) == 0 {
		if err := p.deleteFolder(updated); err != nil {
			return nil, err
		}
		return nil, errFolderNotFound
	}
	return updated, nil
}

// readFolderFor returns the folder if uid is a member or an invitee.
// Anyone else gets errFolderNotFound, so folder IDs can't be probed.
func (p *Plugin) readFolderFor(uid, fid string) (*folderMeta, error) {
	f, err := p.readFolder(fid)
	if err != nil {
		return nil, err
	}
	if f, err = p.lifecycle(f); err != nil {
		return nil, err
	}
	if !contains(f.Members, uid) && !contains(f.Invitees, uid) {
		return nil, errFolderNotFound
	}
	return f, nil
}

func isMember(f *folderMeta, uid string) bool { return contains(f.Members, uid) }

type folderView struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Status    string   `json:"status"`
	Role      string   `json:"role"`
	Owner     string   `json:"owner"`
	Contact   string   `json:"contact,omitempty"`
	Members   []string `json:"members"`
	Invitees  []string `json:"invitees,omitempty"`
	DeleteBy  string   `json:"delete_by,omitempty"`
	DeleteOK  []string `json:"delete_ok,omitempty"`
	ExpiresAt int64    `json:"expires_at,omitempty"`
	CreatedAt int64    `json:"created_at"`
}

func viewFor(f *folderMeta, uid string) folderView {
	role := "member"
	switch {
	case f.Owner == uid:
		role = "owner"
	case !isMember(f, uid):
		role = "invitee"
	}
	return folderView{
		ID: f.ID, Name: f.Name, Kind: f.Kind, Status: f.Status, Role: role, Owner: f.Owner,
		Contact: f.Contact, Members: f.Members, Invitees: f.Invitees, DeleteBy: f.DeleteBy,
		DeleteOK: f.DeleteOK, ExpiresAt: f.ExpiresAt, CreatedAt: f.CreatedAt,
	}
}

func cleanFolderName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n == 0 || n > folderNameMax {
		return "", errFolderBadRequest
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return "", errFolderBadRequest
		}
	}
	return s, nil
}

// uniqueOthers validates a list of user IDs and removes duplicates and the owner.
func uniqueOthers(owner string, ids []string) ([]string, error) {
	seen := map[string]bool{owner: true}
	var out []string
	for _, id := range ids {
		if !model.IsValidId(id) {
			return nil, errFolderBadRequest
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

type createFolderRequest struct {
	Kind          string   `json:"kind"`
	Name          string   `json:"name"`
	ContactUserID string   `json:"contact_user_id"`
	MemberIDs     []string `json:"member_ids"`
}

func (p *Plugin) createFolder(uid string, in createFolderRequest) (*folderMeta, error) {
	name, err := cleanFolderName(in.Name)
	if err != nil {
		return nil, err
	}
	now := foldersNow()
	f := &folderMeta{
		ID: model.NewId(), Name: name, Kind: in.Kind, Owner: uid,
		Members: []string{uid}, Status: folderActive, CreatedAt: now,
	}
	switch in.Kind {
	case folderKindPersonal:
		if in.ContactUserID != "" || len(in.MemberIDs) > 0 {
			return nil, errFolderBadRequest
		}
	case folderKindContact:
		if len(in.MemberIDs) > 0 || !model.IsValidId(in.ContactUserID) || in.ContactUserID == uid {
			return nil, errFolderBadRequest
		}
		if err := p.requireHuman(in.ContactUserID); err != nil {
			return nil, err
		}
		f.Contact = in.ContactUserID
	case folderKindShared, folderKindGroup:
		others, err := uniqueOthers(uid, in.MemberIDs)
		if err != nil {
			return nil, err
		}
		if in.Kind == folderKindShared && len(others) != folderSharedOthers {
			return nil, errFolderBadRequest
		}
		if in.Kind == folderKindGroup && (len(others) < folderGroupMinOther || len(others)+1 > folderGroupMax) {
			return nil, errFolderBadRequest
		}
		for _, o := range others {
			if err := p.requireHuman(o); err != nil {
				return nil, err
			}
			if n, err := p.pendingInvites(o); err != nil {
				return nil, err
			} else if n >= pendingPerUser {
				return nil, errFolderLimit
			}
		}
		f.Invitees = others
		f.Status = folderPending
		f.ExpiresAt = now + int64(folderRequestTTL/time.Millisecond)
	default:
		return nil, errFolderBadRequest
	}

	ids, err := p.userFolders(uid)
	if err != nil {
		return nil, err
	}
	if len(ids) >= foldersPerUser {
		return nil, errFolderLimit
	}
	b, err := json.Marshal(f)
	if err != nil {
		return nil, errFolderStore
	}
	if appErr := p.API.KVSet(keyFolder(f.ID), b); appErr != nil {
		p.API.LogError("folders: create failed", "error", appErr.Error())
		return nil, errFolderStore
	}
	// Index the folder for the owner and every invitee; undo everything on failure.
	for _, uid := range append([]string{f.Owner}, f.Invitees...) {
		if err := p.addToIndex(uid, f.ID); err != nil {
			_ = p.deleteFolder(f)
			return nil, err
		}
	}
	return f, nil
}

// approveCreation: an invitee accepts. When every invitee has accepted, the folder becomes active.
func (p *Plugin) approveCreation(uid, fid string) (*folderMeta, error) {
	if _, err := p.readFolderFor(uid, fid); err != nil {
		return nil, err
	}
	return p.updateFolder(fid, func(x *folderMeta) error {
		if x.Status != folderPending || !contains(x.Invitees, uid) {
			return errFolderState
		}
		x.Invitees = removeFrom(x.Invitees, uid)
		x.Members = append(x.Members, uid)
		if len(x.Invitees) == 0 {
			x.Status, x.ExpiresAt = folderActive, 0
		}
		return nil
	})
}

// rejectCreation: an invitee declines, which cancels the whole folder.
func (p *Plugin) rejectCreation(uid, fid string) error {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return err
	}
	if f.Status != folderPending || !contains(f.Invitees, uid) {
		return errFolderState
	}
	return p.deleteFolder(f)
}

func allApproved(f *folderMeta) bool {
	for _, m := range f.Members {
		if !contains(f.DeleteOK, m) {
			return false
		}
	}
	return true
}

// requestDelete: personal and contact folders are deleted at once by their owner.
// Shared and group folders go to deleting and need every member's approval.
// It returns deleted=true when the folder is gone.
func (p *Plugin) requestDelete(uid, fid string) (deleted bool, err error) {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return false, err
	}
	if !isMember(f, uid) && f.Status != folderPending {
		return false, errFolderForbidden
	}
	switch {
	case f.Status == folderPending:
		if f.Owner != uid {
			return false, errFolderForbidden
		}
		return true, p.deleteFolder(f)
	case f.Kind == folderKindPersonal || f.Kind == folderKindContact:
		if f.Owner != uid {
			return false, errFolderForbidden
		}
		return true, p.deleteFolder(f)
	case f.Status != folderActive:
		return false, errFolderState
	}
	updated, err := p.updateFolder(fid, func(x *folderMeta) error {
		if x.Status != folderActive || !isMember(x, uid) {
			return errFolderState
		}
		x.Status, x.DeleteBy = folderDeleting, uid
		x.DeleteOK = []string{uid}
		x.ExpiresAt = foldersNow() + int64(folderRequestTTL/time.Millisecond)
		return nil
	})
	if err != nil {
		return false, err
	}
	if allApproved(updated) {
		return true, p.deleteFolder(updated)
	}
	return false, nil
}

func (p *Plugin) approveDelete(uid, fid string) (deleted bool, err error) {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return false, err
	}
	if f.Status != folderDeleting || !isMember(f, uid) || contains(f.DeleteOK, uid) {
		return false, errFolderState
	}
	updated, err := p.updateFolder(fid, func(x *folderMeta) error {
		if x.Status != folderDeleting || !isMember(x, uid) {
			return errFolderState
		}
		x.DeleteOK = append(x.DeleteOK, uid)
		return nil
	})
	if err != nil {
		return false, err
	}
	if allApproved(updated) {
		return true, p.deleteFolder(updated)
	}
	return false, nil
}

// rejectDelete: any member can stop the deletion; the folder stays active.
func (p *Plugin) rejectDelete(uid, fid string) error {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return err
	}
	if f.Status != folderDeleting || !isMember(f, uid) {
		return errFolderState
	}
	_, err = p.updateFolder(fid, func(x *folderMeta) error {
		if x.Status != folderDeleting {
			return errFolderState
		}
		x.Status, x.DeleteBy, x.DeleteOK, x.ExpiresAt = folderActive, "", nil, 0
		return nil
	})
	return err
}

// leave: a member of a shared or group folder leaves freely. If the owner
// leaves, ownership goes to the first remaining member. A pending deletion
// is cancelled. A folder with nobody left is deleted.
func (p *Plugin) leave(uid, fid string) error {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return err
	}
	if (f.Kind != folderKindShared && f.Kind != folderKindGroup) || !isMember(f, uid) {
		return errFolderForbidden
	}
	updated, err := p.updateFolder(fid, func(x *folderMeta) error {
		if !isMember(x, uid) {
			return errFolderState
		}
		x.Members = removeFrom(x.Members, uid)
		x.DeleteOK = removeFrom(x.DeleteOK, uid)
		if x.Owner == uid && len(x.Members) > 0 {
			x.Owner = x.Members[0]
		}
		if x.Status == folderDeleting {
			x.Status, x.DeleteBy, x.DeleteOK, x.ExpiresAt = folderActive, "", nil, 0
		}
		return nil
	})
	if err != nil {
		return err
	}
	p.removeFromIndex(uid, fid)
	if len(updated.Members) == 0 {
		return p.deleteFolder(updated)
	}
	return nil
}

type folderItemView struct {
	PostID    string `json:"post_id"`
	ChannelID string `json:"channel_id"`
	AddedBy   string `json:"added_by"`
	AddedAt   int64  `json:"added_at"`
	Message   string `json:"message"`
}

func (p *Plugin) loadItems(fid string) ([]folderItem, error) {
	raw, appErr := p.API.KVGet(keyItems(fid))
	if appErr != nil {
		return nil, errFolderStore
	}
	var items []folderItem
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, errFolderStore
		}
	}
	return items, nil
}

// visibleItems returns the items uid may read right now. Items in channels uid
// can't read are hidden but kept (another member may still read them). Items
// whose post no longer exists or was deleted are removed from the folder, so
// they don't count toward itemsPerFolder.
func (p *Plugin) visibleItems(uid, fid string) ([]folderItemView, error) {
	items, err := p.loadItems(fid)
	if err != nil {
		return nil, err
	}
	out := []folderItemView{}
	canRead := map[string]bool{} // channel → permission, one lookup per channel
	gone := map[string]bool{}
	for _, it := range items {
		post, appErr := p.API.GetPost(it.PostID)
		if appErr != nil && appErr.StatusCode != http.StatusNotFound {
			continue // transient lookup failure: hide for now, keep the item
		}
		if appErr != nil || post == nil || post.DeleteAt != 0 {
			gone[it.PostID] = true
			continue
		}
		allowed, seen := canRead[post.ChannelId]
		if !seen {
			allowed = p.API.HasPermissionToChannel(uid, post.ChannelId, model.PermissionReadChannelContent)
			canRead[post.ChannelId] = allowed
		}
		if !allowed {
			continue
		}
		out = append(out, folderItemView{
			PostID: it.PostID, ChannelID: post.ChannelId, AddedBy: it.AddedBy,
			AddedAt: it.AddedAt, Message: post.Message,
		})
	}
	if len(gone) > 0 {
		p.dropItems(fid, gone)
	}
	return out, nil
}

// dropItems removes the given posts from a folder's item list (best effort).
func (p *Plugin) dropItems(fid string, gone map[string]bool) {
	err := p.casKV(keyItems(fid), func(old []byte) ([]byte, error) {
		var items []folderItem
		if len(old) > 0 {
			if err := json.Unmarshal(old, &items); err != nil {
				return nil, errFolderStore
			}
		}
		kept := make([]folderItem, 0, len(items))
		for _, it := range items {
			if !gone[it.PostID] {
				kept = append(kept, it)
			}
		}
		if len(kept) == len(items) {
			return nil, errNoChange
		}
		return json.Marshal(kept)
	})
	if err != nil {
		p.API.LogWarn("folders: could not remove deleted posts", "folder_id", fid)
	}
}

// addItem: the caller must be an active member and must be able to read the post.
func (p *Plugin) addItem(uid, fid, postID string) error {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return err
	}
	if !isMember(f, uid) || f.Status != folderActive {
		return errFolderState
	}
	post, appErr := p.API.GetPost(postID)
	if appErr != nil || post == nil || post.DeleteAt != 0 {
		return errFolderNotFound
	}
	if !p.API.HasPermissionToChannel(uid, post.ChannelId, model.PermissionReadChannelContent) {
		return errFolderNotFound // same answer as a missing post
	}
	return p.casKV(keyItems(fid), func(old []byte) ([]byte, error) {
		var items []folderItem
		if len(old) > 0 {
			if err := json.Unmarshal(old, &items); err != nil {
				return nil, errFolderStore
			}
		}
		for _, it := range items {
			if it.PostID == postID {
				return nil, errNoChange // already in the folder
			}
		}
		if len(items) >= itemsPerFolder {
			return nil, errFolderLimit
		}
		items = append(items, folderItem{PostID: postID, ChannelID: post.ChannelId, AddedBy: uid, AddedAt: foldersNow()})
		b, err := json.Marshal(items)
		if err != nil {
			return nil, errFolderStore
		}
		return b, nil
	})
}

// removeItem: any active member can remove an item.
func (p *Plugin) removeItem(uid, fid, postID string) (bool, error) {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return false, err
	}
	if !isMember(f, uid) || f.Status == folderPending {
		return false, errFolderState
	}
	removed := false
	err = p.casKV(keyItems(fid), func(old []byte) ([]byte, error) {
		var items []folderItem
		if len(old) > 0 {
			if err := json.Unmarshal(old, &items); err != nil {
				return nil, errFolderStore
			}
		}
		kept := make([]folderItem, 0, len(items))
		for _, it := range items {
			if it.PostID != postID {
				kept = append(kept, it)
			}
		}
		removed = len(kept) != len(items)
		if !removed {
			return nil, errNoChange
		}
		b, err := json.Marshal(kept)
		if err != nil {
			return nil, errFolderStore
		}
		return b, nil
	})
	return removed, err
}

// handleFolders routes /api/v1/folders... (called only for an authenticated user).
func (p *Plugin) handleFolders(w http.ResponseWriter, r *http.Request, uid string) {
	if !p.getConfig().EnableSharedFolders {
		writeError(w, http.StatusNotFound, "disabled")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/folders"), "/")
	var parts []string
	if rest != "" {
		parts = strings.Split(rest, "/")
	}
	if len(parts) > 0 && !model.IsValidId(parts[0]) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	switch {
	case len(parts) == 0 && r.Method == http.MethodGet:
		p.listFolders(w, uid)
	case len(parts) == 0 && r.Method == http.MethodPost:
		p.handleCreateFolder(w, r, uid)
	case len(parts) == 1 && r.Method == http.MethodGet:
		p.getFolder(w, uid, parts[0])
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "approve":
		f, err := p.approveCreation(uid, parts[0])
		if err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, viewFor(f, uid))
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "reject":
		if err := p.rejectCreation(uid, parts[0]); err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "delete-request":
		deleted, err := p.requestDelete(uid, parts[0])
		if err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
	case len(parts) == 3 && r.Method == http.MethodPost && parts[1] == "delete-request" && parts[2] == "approve":
		deleted, err := p.approveDelete(uid, parts[0])
		if err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
	case len(parts) == 3 && r.Method == http.MethodPost && parts[1] == "delete-request" && parts[2] == "reject":
		if err := p.rejectDelete(uid, parts[0]); err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": false})
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "leave":
		if err := p.leave(uid, parts[0]); err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"left": true})
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "items":
		var body struct {
			PostID string `json:"post_id"`
		}
		if err := decodeFolderBody(w, r, &body); err != nil || !model.IsValidId(body.PostID) {
			writeError(w, http.StatusBadRequest, "bad_request")
			return
		}
		if err := p.addItem(uid, parts[0], body.PostID); err != nil {
			writeFolderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"added": true})
	case len(parts) == 3 && r.Method == http.MethodDelete && parts[1] == "items":
		if !model.IsValidId(parts[2]) {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		removed, err := p.removeItem(uid, parts[0], parts[2])
		if err != nil {
			writeFolderError(w, err)
			return
		}
		if !removed {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"removed": true})
	default:
		writeError(w, http.StatusNotFound, "not_found")
	}
}

func decodeFolderBody(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(v)
}

func (p *Plugin) handleCreateFolder(w http.ResponseWriter, r *http.Request, uid string) {
	var in createFolderRequest
	if err := decodeFolderBody(w, r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	f, err := p.createFolder(uid, in)
	if err != nil {
		writeFolderError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, viewFor(f, uid))
}

// listFolders returns the folders uid is in or invited to. Index entries that
// no longer match (left, deleted, expired) are dropped here.
func (p *Plugin) listFolders(w http.ResponseWriter, uid string) {
	ids, err := p.userFolders(uid)
	if err != nil {
		writeFolderError(w, err)
		return
	}
	out := []folderView{}
	for _, id := range ids {
		f, err := p.readFolderFor(uid, id)
		if errors.Is(err, errFolderNotFound) {
			p.removeFromIndex(uid, id)
			continue
		}
		if err != nil {
			writeFolderError(w, err)
			return
		}
		out = append(out, viewFor(f, uid))
	}
	writeJSON(w, http.StatusOK, map[string]any{"folders": out})
}

func (p *Plugin) getFolder(w http.ResponseWriter, uid, fid string) {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		writeFolderError(w, err)
		return
	}
	items := []folderItemView{}
	if isMember(f, uid) {
		items, err = p.visibleItems(uid, fid)
		if err != nil {
			writeFolderError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"folder": viewFor(f, uid), "items": items})
}
