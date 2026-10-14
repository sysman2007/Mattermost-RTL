package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

// Plugin is the server side of Mattermost RTL. Today it has one job: the
// optional AI («هوشمند») Markdown conversion of a post through LiteLLM. The
// API key lives only here; browsers send a post ID, never text or keys.
type Plugin struct {
	plugin.MattermostPlugin

	configLock sync.RWMutex
	config     configuration

	llm     *llmClient
	limiter *rateLimiter
	// The model serves one request at a time, so so do we.
	slot chan struct{}
}

const (
	cacheTTL     = 30 * 24 * time.Hour
	slotWait     = 15 * time.Second
	cacheVersion = "v1"
)

func (p *Plugin) OnActivate() error {
	p.llm = &llmClient{http: &http.Client{}}
	p.limiter = newRateLimiter()
	p.slot = make(chan struct{}, 1)
	return nil
}

func (p *Plugin) OnConfigurationChange() error {
	var c configuration
	if err := p.API.LoadPluginConfiguration(&c); err != nil {
		return err
	}
	c = c.normalized()
	if err := c.validate(); err != nil {
		return err
	}
	p.configLock.Lock()
	p.config = c
	p.configLock.Unlock()
	return nil
}

func (p *Plugin) getConfig() configuration {
	p.configLock.RLock()
	defer p.configLock.RUnlock()
	return p.config
}

func (p *Plugin) ServeHTTP(_ *plugin.Context, w http.ResponseWriter, r *http.Request) {
	// Set by the server only for authenticated requests.
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	switch {
	case r.URL.Path == "/api/v1/ai/status" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"enabled": p.getConfig().EnableAIMarkdown})
	case r.URL.Path == "/api/v1/ai/markdown" && r.Method == http.MethodPost:
		p.handleMarkdown(w, r, userID)
	default:
		writeError(w, http.StatusNotFound, "not_found")
	}
}

func (p *Plugin) handleMarkdown(w http.ResponseWriter, r *http.Request, userID string) {
	cfg := p.getConfig()
	if !cfg.EnableAIMarkdown {
		writeError(w, http.StatusNotFound, "disabled")
		return
	}
	var body struct {
		PostID string `json:"post_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || !model.IsValidId(body.PostID) {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	post, appErr := p.API.GetPost(body.PostID)
	if appErr != nil || post == nil || post.DeleteAt != 0 {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	// Same 404 as a missing post, so post IDs in other channels can't be probed.
	if !p.API.HasPermissionToChannel(userID, post.ChannelId, model.PermissionReadChannelContent) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	text := post.Message
	if text == "" {
		writeError(w, http.StatusBadRequest, "empty")
		return
	}
	if utf8.RuneCountInString(text) > cfg.MaxInputChars {
		writeError(w, http.StatusRequestEntityTooLarge, "too_long")
		return
	}

	key := cacheKey(cfg, post)
	if cached, appErr := p.API.KVGet(key); appErr == nil && len(cached) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"markdown": string(cached), "cached": true})
		return
	}

	if ok, retry := p.limiter.allow(userID, cfg.RateLimitPerMinute, time.Now()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}

	waitCtx, cancelWait := context.WithTimeout(r.Context(), slotWait)
	defer cancelWait()
	select {
	case p.slot <- struct{}{}:
		defer func() { <-p.slot }()
	case <-waitCtx.Done():
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	}

	start := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(cfg.TimeoutSeconds)*time.Second)
	defer cancel()
	md, err := p.llm.toMarkdown(ctx, cfg, text)
	logFields := []any{"user_id", userID, "post_id", post.Id, "duration_ms", time.Since(start).Milliseconds()}
	switch {
	case err == nil:
		if _, appErr := p.API.KVSetWithOptions(key, []byte(md), model.PluginKVSetOptions{ExpireInSeconds: int64(cacheTTL.Seconds())}); appErr != nil {
			p.API.LogWarn("AI markdown: cache write failed", "error", appErr.Error())
		}
		p.API.LogInfo("AI markdown: converted", logFields...)
		writeJSON(w, http.StatusOK, map[string]any{"markdown": md, "cached": false})
	case errors.Is(err, errTruncated):
		p.API.LogWarn("AI markdown: output truncated", logFields...)
		writeJSON(w, http.StatusOK, map[string]any{"markdown": md, "cached": false, "truncated": true})
	case errors.Is(err, context.DeadlineExceeded):
		p.API.LogWarn("AI markdown: timeout", logFields...)
		writeError(w, http.StatusGatewayTimeout, "timeout")
	case errors.Is(err, context.Canceled):
		// The browser went away; nothing to answer.
	default:
		p.API.LogError("AI markdown: upstream failed", append(logFields, "error", err.Error())...)
		writeError(w, http.StatusBadGateway, "upstream")
	}
}

// cacheKey changes when the post is edited or the model/instructions change.
func cacheKey(cfg configuration, post *model.Post) string {
	h := sha256.Sum256([]byte(post.Id + "|" + strconv.FormatInt(post.EditAt, 10) + "|" + cfg.LiteLLMModel + "|" + cfg.ExtraInstructions + "|" + systemPrompt))
	return "mdai_" + cacheVersion + "_" + hex.EncodeToString(h[:16])
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// rateLimiter: a per-user sliding one-minute window, in memory. Fine for a
// single server; in a cluster each node keeps its own window.
type rateLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newRateLimiter() *rateLimiter { return &rateLimiter{hits: map[string][]time.Time{}} }

func (l *rateLimiter) allow(userID string, perMinute int, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-time.Minute)
	kept := l.hits[userID][:0]
	for _, t := range l.hits[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= perMinute {
		l.hits[userID] = kept
		return false, kept[0].Sub(cutoff)
	}
	l.hits[userID] = append(kept, now)
	if len(l.hits) > 10000 { // drop idle users so the map can't grow without bound
		for id, ts := range l.hits {
			if len(ts) == 0 || !ts[len(ts)-1].After(cutoff) {
				delete(l.hits, id)
			}
		}
	}
	return true, 0
}

func main() {
	plugin.ClientMain(&Plugin{})
}
