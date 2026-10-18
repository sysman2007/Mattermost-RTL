package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
)

// Folder-only notes: a message (text and/or files) that exists only in a folder.
// It never appears in a conversation. Its files are stored with Mattermost's
// file store (plugin UploadFile) without a post, so they don't show in any
// conversation or in file search. Mattermost doesn't link such files to a
// channel, so its own file API can't serve them: the plugin serves them at
// /folders/{fid}/notes/{nid}/files/{fileId}, to folder members only.
//
// A note is its own KV document (fn_<id>); the folder's item list only refers
// to it, so long notes don't bloat the list. Reactions on a note live in the
// note and are seen only in the folder. Reactions on a saved conversation
// message are Mattermost's own and show in both places.

const (
	noteTextMax       = 4000
	noteFilesMax      = 10
	noteReactionsMax  = 20 // distinct emojis per note
	defaultMaxFileMiB = 100
)

var emojiNameRe = regexp.MustCompile(`^[a-z0-9_+\-]{1,64}$`)

type folderNote struct {
	ID        string              `json:"id"`
	FolderID  string              `json:"folder_id"`
	UserID    string              `json:"user_id"`
	Text      string              `json:"text"`
	FileIDs   []string            `json:"file_ids,omitempty"`
	Reactions map[string][]string `json:"reactions,omitempty"` // emoji → user IDs
	CreateAt  int64               `json:"create_at"`
}

type fileView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Extension  string `json:"extension"`
	Size       int64  `json:"size"`
	MimeType   string `json:"mime_type"`
	HasPreview bool   `json:"has_preview_image"`
}

func keyNote(nid string) string { return "fn_" + nid }

// itemID is the key of an item in the folder: the post ID or the note ID.
func itemID(it folderItem) string {
	if it.NoteID != "" {
		return it.NoteID
	}
	return it.PostID
}

func (p *Plugin) readNote(nid string) (*folderNote, error) {
	raw, appErr := p.API.KVGet(keyNote(nid))
	if appErr != nil {
		return nil, errFolderStore
	}
	if len(raw) == 0 {
		return nil, errFolderNotFound
	}
	var n folderNote
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, errFolderStore
	}
	return &n, nil
}

func (p *Plugin) fileViews(ids []string) []fileView {
	out := []fileView{}
	for _, id := range ids {
		fi, appErr := p.API.GetFileInfo(id)
		if appErr != nil || fi == nil || fi.DeleteAt != 0 {
			continue
		}
		out = append(out, fileView{ID: fi.Id, Name: fi.Name, Extension: fi.Extension, Size: fi.Size, MimeType: fi.MimeType, HasPreview: fi.HasPreviewImage})
	}
	return out
}

// postReactions returns emoji → user IDs for a conversation message.
func (p *Plugin) postReactions(post *model.Post) map[string][]string {
	out := map[string][]string{}
	if !post.HasReactions {
		return out
	}
	rs, appErr := p.API.GetReactions(post.Id)
	if appErr != nil {
		return out
	}
	for _, r := range rs {
		out[r.EmojiName] = append(out[r.EmojiName], r.UserId)
	}
	return out
}

// folderChannel is the conversation that belongs to a folder: where folder-only
// files are stored and where «send in the conversation» posts go. Personal and
// contact folders use uid's conversation with themselves.
func (p *Plugin) folderChannel(f *folderMeta, uid string) (string, error) {
	var ch *model.Channel
	var appErr *model.AppError
	switch {
	case (f.Kind == folderKindShared || f.Kind == folderKindGroup) && len(f.Members) == 2:
		ch, appErr = p.API.GetDirectChannel(f.Members[0], f.Members[1])
	case f.Kind == folderKindGroup && len(f.Members) >= 3:
		ch, appErr = p.API.GetGroupChannel(f.Members)
	default:
		ch, appErr = p.API.GetDirectChannel(uid, uid)
	}
	if appErr != nil || ch == nil {
		if appErr != nil {
			p.API.LogError("folders: conversation lookup failed", "folder_id", f.ID, "error", appErr.Error())
		}
		return "", errFolderStore
	}
	return ch.Id, nil
}

func (p *Plugin) maxFileSize() int64 {
	if cfg := p.API.GetConfig(); cfg != nil && cfg.FileSettings.MaxFileSize != nil && *cfg.FileSettings.MaxFileSize > 0 {
		return *cfg.FileSettings.MaxFileSize
	}
	return defaultMaxFileMiB << 20
}

func cleanFileName(name string) string {
	name = strings.TrimSpace(path.Base(strings.ReplaceAll(name, "\\", "/")))
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	if utf8.RuneCountInString(name) > 200 {
		name = string([]rune(name)[:200])
	}
	return name
}

// activeMemberFolder returns the folder if uid is an active member of an active folder.
func (p *Plugin) activeMemberFolder(uid, fid string) (*folderMeta, error) {
	f, err := p.readFolderFor(uid, fid)
	if err != nil {
		return nil, err
	}
	if !isMember(f, uid) || f.Status != folderActive {
		return nil, errFolderState
	}
	return f, nil
}

// createNote handles a multipart form: "text" and up to noteFilesMax "files".
func (p *Plugin) createNote(w http.ResponseWriter, r *http.Request, uid, fid string) (*folderNote, error) {
	f, err := p.activeMemberFolder(uid, fid)
	if err != nil {
		return nil, err
	}
	maxFile := p.maxFileSize()
	r.Body = http.MaxBytesReader(w, r.Body, maxFile*noteFilesMax+1<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return nil, errFolderBadRequest
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()

	text := strings.TrimSpace(r.FormValue("text"))
	files := r.MultipartForm.File["files"]
	if (text == "" && len(files) == 0) || utf8.RuneCountInString(text) > noteTextMax || len(files) > noteFilesMax {
		return nil, errFolderBadRequest
	}
	for _, fh := range files {
		if fh.Size > maxFile {
			return nil, errFolderLimit
		}
	}
	items, err := p.loadItems(fid)
	if err != nil {
		return nil, err
	}
	if len(items) >= itemsPerFolder {
		return nil, errFolderLimit
	}

	note := &folderNote{ID: model.NewId(), FolderID: fid, UserID: uid, Text: text, CreateAt: foldersNow()}
	if len(files) > 0 {
		channelID, err := p.folderChannel(f, uid)
		if err != nil {
			return nil, err
		}
		for _, fh := range files {
			src, err := fh.Open()
			if err != nil {
				return nil, errFolderBadRequest
			}
			data, err := io.ReadAll(io.LimitReader(src, maxFile+1))
			_ = src.Close()
			if err != nil || int64(len(data)) > maxFile {
				return nil, errFolderLimit
			}
			info, appErr := p.API.UploadFile(data, channelID, cleanFileName(fh.Filename))
			if appErr != nil || info == nil {
				if appErr != nil {
					p.API.LogError("folders: file upload failed", "folder_id", fid, "error", appErr.Error())
				}
				return nil, errFolderStore
			}
			note.FileIDs = append(note.FileIDs, info.Id)
		}
	}

	b, err := json.Marshal(note)
	if err != nil {
		return nil, errFolderStore
	}
	if appErr := p.API.KVSet(keyNote(note.ID), b); appErr != nil {
		return nil, errFolderStore
	}
	err = p.casKV(keyItems(fid), func(old []byte) ([]byte, error) {
		var list []folderItem
		if len(old) > 0 {
			if err := json.Unmarshal(old, &list); err != nil {
				return nil, errFolderStore
			}
		}
		if len(list) >= itemsPerFolder {
			return nil, errFolderLimit
		}
		list = append(list, folderItem{NoteID: note.ID, AddedBy: uid, AddedAt: note.CreateAt})
		return json.Marshal(list)
	})
	if err != nil {
		_ = p.API.KVDelete(keyNote(note.ID))
		return nil, err
	}
	return note, nil
}

// noteInFolder checks that nid is an item of fid (so a member of one folder
// can't touch another folder's notes by ID).
func (p *Plugin) noteInFolder(fid, nid string) (*folderNote, error) {
	n, err := p.readNote(nid)
	if err != nil {
		return nil, err
	}
	if n.FolderID != fid {
		return nil, errFolderNotFound
	}
	return n, nil
}

// reactNote adds (add=true) or removes uid's emoji on a note.
func (p *Plugin) reactNote(uid, fid, nid, emoji string, add bool) (*folderNote, error) {
	if !emojiNameRe.MatchString(emoji) {
		return nil, errFolderBadRequest
	}
	if _, err := p.activeMemberFolder(uid, fid); err != nil {
		return nil, err
	}
	if _, err := p.noteInFolder(fid, nid); err != nil {
		return nil, err
	}
	var out folderNote
	err := p.casKV(keyNote(nid), func(old []byte) ([]byte, error) {
		if len(old) == 0 {
			return nil, errFolderNotFound
		}
		var n folderNote
		if err := json.Unmarshal(old, &n); err != nil {
			return nil, errFolderStore
		}
		if n.Reactions == nil {
			n.Reactions = map[string][]string{}
		}
		users := n.Reactions[emoji]
		switch {
		case add && contains(users, uid), !add && !contains(users, uid):
			out = n
			return nil, errNoChange
		case add:
			if _, exists := n.Reactions[emoji]; !exists && len(n.Reactions) >= noteReactionsMax {
				return nil, errFolderLimit
			}
			n.Reactions[emoji] = append(users, uid)
		default:
			if left := removeFrom(users, uid); len(left) > 0 {
				n.Reactions[emoji] = left
			} else {
				delete(n.Reactions, emoji)
			}
		}
		out = n
		return json.Marshal(n)
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (p *Plugin) noteView(n *folderNote, it folderItem) folderItemView {
	reactions := n.Reactions
	if reactions == nil {
		reactions = map[string][]string{}
	}
	return folderItemView{
		Kind: "note", ID: n.ID, UserID: n.UserID, CreateAt: n.CreateAt,
		AddedBy: it.AddedBy, AddedAt: it.AddedAt, Message: n.Text,
		Files: p.fileViews(n.FileIDs), Reactions: reactions,
	}
}

// inlineMime: types a browser may show in place (raster images, audio, video).
// Everything else, SVG and HTML included, is sent as an attachment.
func inlineMime(m string) bool {
	switch {
	case strings.HasPrefix(m, "image/"):
		return m == "image/png" || m == "image/jpeg" || m == "image/gif" || m == "image/webp" || m == "image/bmp"
	case strings.HasPrefix(m, "video/"), strings.HasPrefix(m, "audio/"):
		return true
	}
	return false
}

// serveNoteFile sends one file of a note to a folder member.
func (p *Plugin) serveNoteFile(w http.ResponseWriter, r *http.Request, uid, fid, nid, fileID string) {
	if !model.IsValidId(nid) || !model.IsValidId(fileID) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	f, err := p.readFolderFor(uid, fid)
	if err == nil && !isMember(f, uid) {
		err = errFolderNotFound
	}
	var n *folderNote
	if err == nil {
		n, err = p.noteInFolder(fid, nid)
	}
	if err == nil && !contains(n.FileIDs, fileID) {
		err = errFolderNotFound
	}
	if err != nil {
		writeFolderError(w, err)
		return
	}
	fi, appErr := p.API.GetFileInfo(fileID)
	if appErr != nil || fi == nil || fi.DeleteAt != 0 {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	data, appErr := p.API.GetFile(fileID)
	if appErr != nil {
		p.API.LogError("Folder note file could not be read", "file_id", fileID, "error", appErr.Error())
		writeError(w, http.StatusInternalServerError, "store_failed")
		return
	}
	ctype := fi.MimeType
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	disposition := "attachment"
	if r.URL.Query().Get("download") == "" && inlineMime(ctype) {
		disposition = "inline"
	} else if !inlineMime(ctype) {
		ctype = "application/octet-stream" // never let the browser render it as a page
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": fi.Name}))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", model.GetTimeForMillis(fi.CreateAt), bytes.NewReader(data))
}

// handleNotes routes /api/v1/folders/{fid}/notes... and /conversation.
// parts[0] is the folder ID and parts[1] is "notes" or "conversation".
func (p *Plugin) handleNotes(w http.ResponseWriter, r *http.Request, uid string, parts []string) bool {
	fid := parts[0]
	switch {
	case len(parts) == 2 && parts[1] == "conversation" && r.Method == http.MethodPost:
		f, err := p.activeMemberFolder(uid, fid)
		if err == nil {
			var ch string
			if ch, err = p.folderChannel(f, uid); err == nil {
				writeJSON(w, http.StatusOK, map[string]any{"channel_id": ch})
				return true
			}
		}
		writeFolderError(w, err)
	case len(parts) == 2 && parts[1] == "notes" && r.Method == http.MethodPost:
		n, err := p.createNote(w, r, uid, fid)
		if err != nil {
			writeFolderError(w, err)
			return true
		}
		writeJSON(w, http.StatusCreated, p.noteView(n, folderItem{NoteID: n.ID, AddedBy: uid, AddedAt: n.CreateAt}))
	case len(parts) == 5 && parts[1] == "notes" && parts[3] == "files" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		p.serveNoteFile(w, r, uid, fid, parts[2], parts[4])
	case len(parts) == 4 && parts[1] == "notes" && parts[3] == "reactions" && r.Method == http.MethodPost:
		var body struct {
			EmojiName string `json:"emoji_name"`
		}
		if !model.IsValidId(parts[2]) || decodeFolderBody(w, r, &body) != nil {
			writeError(w, http.StatusBadRequest, "bad_request")
			return true
		}
		n, err := p.reactNote(uid, fid, parts[2], body.EmojiName, true)
		if err != nil {
			writeFolderError(w, err)
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"reactions": n.Reactions})
	case len(parts) == 5 && parts[1] == "notes" && parts[3] == "reactions" && r.Method == http.MethodDelete:
		if !model.IsValidId(parts[2]) {
			writeError(w, http.StatusNotFound, "not_found")
			return true
		}
		n, err := p.reactNote(uid, fid, parts[2], parts[4], false)
		if err != nil {
			writeFolderError(w, err)
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"reactions": n.Reactions})
	default:
		return false
	}
	return true
}
