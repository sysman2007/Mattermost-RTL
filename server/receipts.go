package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
)

// Read receipts («تیک دیده‌شدن»). Mattermost hides other members'
// last_viewed_at from the REST API; the plugin API returns it. Because this
// exposes behaviour users could not see before, it is guarded by:
//   - an admin switch, off by default;
//   - a one-time notice per user: until a user acknowledges it, their views
//     are never reported to anyone and they see no receipts themselves;
//   - data minimisation: only «seen / not seen» per post is returned, never
//     view timestamps, and only for the requester's own posts;
//   - the requester must be able to read the channel.

const (
	// Bump when the notice text changes materially, so users see it again.
	receiptsNoticeVersion = "v1"
	ackKeyPrefix          = "rr_ack_" + receiptsNoticeVersion + "_"
	maxPostsPerRequest    = 50
	namesUpTo             = 50 // list who saw a post only in channels up to this size
	snapshotTTL           = 5 * time.Second
	ackRefresh            = 5 * time.Minute
	receiptsPerMinute     = 30
)

type memberView struct {
	userID       string
	lastViewedAt int64
}

type channelSnapshot struct {
	at      time.Time
	members []memberView // other human, active members (acknowledged or not)
}

type receipts struct {
	mu        sync.Mutex
	acks      map[string]bool
	acksAt    time.Time
	snapshots map[string]channelSnapshot
	limiter   *rateLimiter
}

func newReceipts() *receipts {
	return &receipts{acks: map[string]bool{}, snapshots: map[string]channelSnapshot{}, limiter: newRateLimiter()}
}

// loadAcks refreshes the in-memory set of acknowledged users from the KV
// store (so acks made on another node are picked up within ackRefresh).
func (p *Plugin) loadAcks(force bool) map[string]bool {
	rc := p.receipts
	rc.mu.Lock()
	if !force && time.Since(rc.acksAt) < ackRefresh {
		acks := rc.acks
		rc.mu.Unlock()
		return acks
	}
	rc.mu.Unlock()

	acks := map[string]bool{}
	for page := 0; ; page++ {
		keys, appErr := p.API.KVList(page, 1000)
		if appErr != nil {
			p.API.LogWarn("read receipts: listing acknowledgements failed", "error", appErr.Error())
			break
		}
		for _, k := range keys {
			if strings.HasPrefix(k, ackKeyPrefix) {
				acks[strings.TrimPrefix(k, ackKeyPrefix)] = true
			}
		}
		if len(keys) < 1000 {
			break
		}
	}
	rc.mu.Lock()
	rc.acks, rc.acksAt = acks, time.Now()
	rc.mu.Unlock()
	return acks
}

func (p *Plugin) acknowledged(userID string) bool {
	if p.loadAcks(false)[userID] {
		return true
	}
	// Not in the cached set: check the store directly (ack on another node).
	v, appErr := p.API.KVGet(ackKeyPrefix + userID)
	return appErr == nil && len(v) > 0
}

func (p *Plugin) handleReceiptsStatus(w http.ResponseWriter, userID string) {
	enabled := p.getConfig().EnableReadReceipts
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":        enabled,
		"acknowledged":   enabled && p.acknowledged(userID),
		"notice_version": receiptsNoticeVersion,
	})
}

func (p *Plugin) handleReceiptsAck(w http.ResponseWriter, userID string) {
	if !p.getConfig().EnableReadReceipts {
		writeError(w, http.StatusNotFound, "disabled")
		return
	}
	if appErr := p.API.KVSet(ackKeyPrefix+userID, []byte(strconv.FormatInt(model.GetMillis(), 10))); appErr != nil {
		writeError(w, http.StatusInternalServerError, "store_failed")
		return
	}
	p.receipts.mu.Lock()
	p.receipts.acks[userID] = true
	p.receipts.mu.Unlock()
	p.API.LogInfo("read receipts: notice acknowledged", "user_id", userID, "notice_version", receiptsNoticeVersion)
	writeJSON(w, http.StatusOK, map[string]any{"acknowledged": true})
}

// channelMembers returns the other human, active members with their
// last_viewed_at, cached briefly so many open clients share one lookup.
func (p *Plugin) channelMembers(channelID string, limit int) ([]memberView, bool, error) {
	rc := p.receipts
	rc.mu.Lock()
	if s, ok := rc.snapshots[channelID]; ok && time.Since(s.at) < snapshotTTL {
		rc.mu.Unlock()
		return s.members, false, nil
	}
	rc.mu.Unlock()

	stats, appErr := p.API.GetChannelStats(channelID)
	if appErr != nil {
		return nil, false, appErr
	}
	if int(stats.MemberCount) > limit {
		return nil, true, nil
	}
	humans := map[string]bool{}
	for page := 0; ; page++ {
		users, appErr := p.API.GetUsersInChannel(channelID, model.ChannelSortByUsername, page, 200)
		if appErr != nil {
			return nil, false, appErr
		}
		for _, u := range users {
			if !u.IsBot && u.DeleteAt == 0 {
				humans[u.Id] = true
			}
		}
		if len(users) < 200 {
			break
		}
	}
	var members []memberView
	for page := 0; ; page++ {
		ms, appErr := p.API.GetChannelMembers(channelID, page, 200)
		if appErr != nil {
			return nil, false, appErr
		}
		for _, m := range ms {
			if humans[m.UserId] {
				members = append(members, memberView{userID: m.UserId, lastViewedAt: m.LastViewedAt})
			}
		}
		if len(ms) < 200 {
			break
		}
	}
	rc.mu.Lock()
	rc.snapshots[channelID] = channelSnapshot{at: time.Now(), members: members}
	if len(rc.snapshots) > 5000 {
		for id, s := range rc.snapshots {
			if time.Since(s.at) > snapshotTTL {
				delete(rc.snapshots, id)
			}
		}
	}
	rc.mu.Unlock()
	return members, false, nil
}

type postReceipt struct {
	Seen int      `json:"seen"`
	By   []string `json:"by,omitempty"`
}

func (p *Plugin) handleReceipts(w http.ResponseWriter, r *http.Request, userID string) {
	cfg := p.getConfig()
	if !cfg.EnableReadReceipts {
		writeError(w, http.StatusNotFound, "disabled")
		return
	}
	if !p.acknowledged(userID) {
		writeError(w, http.StatusForbidden, "notice_required")
		return
	}
	var body struct {
		ChannelID string   `json:"channel_id"`
		PostIDs   []string `json:"post_ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil ||
		!model.IsValidId(body.ChannelID) || len(body.PostIDs) == 0 || len(body.PostIDs) > maxPostsPerRequest {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if !p.API.HasPermissionToChannel(userID, body.ChannelID, model.PermissionReadChannelContent) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if ok, retry := p.receipts.limiter.allow(userID, receiptsPerMinute, time.Now()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}

	// Only the requester's own, live posts in this channel; anything else is ignored.
	created := map[string]int64{}
	for _, id := range body.PostIDs {
		if !model.IsValidId(id) {
			continue
		}
		post, appErr := p.API.GetPost(id)
		if appErr != nil || post == nil || post.UserId != userID || post.ChannelId != body.ChannelID || post.DeleteAt != 0 {
			continue
		}
		created[id] = post.CreateAt
	}

	members, tooLarge, err := p.channelMembers(body.ChannelID, cfg.ReceiptsMaxMembers)
	if err != nil {
		p.API.LogError("read receipts: member lookup failed", "channel_id", body.ChannelID, "error", err.Error())
		writeError(w, http.StatusInternalServerError, "lookup_failed")
		return
	}
	if tooLarge {
		writeJSON(w, http.StatusOK, map[string]any{"too_large": true})
		return
	}

	acks := p.loadAcks(false)
	others := 0
	for _, m := range members {
		if m.userID != userID {
			others++
		}
	}
	withNames := others <= namesUpTo
	out := map[string]postReceipt{}
	for id, at := range created {
		rec := postReceipt{}
		for _, m := range members {
			// Members who haven't acknowledged the notice are never reported.
			if m.userID == userID || !acks[m.userID] || m.lastViewedAt < at {
				continue
			}
			rec.Seen++
			if withNames {
				rec.By = append(rec.By, m.userID)
			}
		}
		out[id] = rec
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": others, "posts": out})
}
