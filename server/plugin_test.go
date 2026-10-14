package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

const (
	userID    = "uuuuuuuuuuuuuuuuuuuuuuuuuu"
	postID    = "pppppppppppppppppppppppppp"
	channelID = "cccccccccccccccccccccccccc"
	testKey   = "sk-test-not-a-real-key"
)

// fakeLLM records the last request and answers with the given status/body.
type fakeLLM struct {
	srv    *httptest.Server
	calls  atomic.Int32
	last   chatRequest
	auth   string
	status int
	reply  string
	finish string
	delay  time.Duration
}

func newFakeLLM(t *testing.T) *fakeLLM {
	f := &fakeLLM{status: http.StatusOK, reply: "# عنوان\n\n- مورد", finish: "stop"}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		f.auth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		require.NoError(t, json.Unmarshal(body, &f.last))
		if f.delay > 0 {
			select {
			case <-time.After(f.delay):
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(f.status)
		if f.status != http.StatusOK {
			_, _ = w.Write([]byte(`{"error":"prompt was: ` + f.last.Messages[1].Content + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{
			"message": map[string]any{"content": f.reply}, "finish_reason": f.finish}}})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type harness struct {
	p   *Plugin
	api *plugintest.API
	llm *fakeLLM
}

func setup(t *testing.T, message string, mutate func(*configuration)) *harness {
	llm := newFakeLLM(t)
	api := &plugintest.API{}
	api.On("LogInfo", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Maybe()
	api.On("LogWarn", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Maybe()
	api.On("LogWarn", mock.Anything, mock.Anything, mock.Anything).Maybe()
	api.On("LogError", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Maybe()
	api.On("GetPost", postID).Return(&model.Post{Id: postID, ChannelId: channelID, Message: message, EditAt: 7}, nil).Maybe()
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannelContent).Return(true).Maybe()
	api.On("KVGet", mock.Anything).Return(nil, nil).Maybe()
	api.On("KVSetWithOptions", mock.Anything, mock.Anything, mock.Anything).Return(true, nil).Maybe()

	p := &Plugin{}
	p.SetAPI(api)
	require.NoError(t, p.OnActivate())
	cfg := configuration{EnableAIMarkdown: true, LiteLLMBaseURL: llm.srv.URL + "/v1/", LiteLLMAPIKey: testKey}
	if mutate != nil {
		mutate(&cfg)
	}
	p.config = cfg.normalized()
	return &harness{p: p, api: api, llm: llm}
}

func (h *harness) call(method, path, body, user string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if user != "" {
		r.Header.Set("Mattermost-User-Id", user)
	}
	w := httptest.NewRecorder()
	h.p.ServeHTTP(nil, w, r)
	return w
}

func (h *harness) convert() *httptest.ResponseRecorder {
	return h.call(http.MethodPost, "/api/v1/ai/markdown", `{"post_id":"`+postID+`"}`, userID)
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	return m
}

func TestUnauthenticatedIsRejected(t *testing.T) {
	h := setup(t, "x", nil)
	assert.Equal(t, http.StatusUnauthorized, h.call(http.MethodPost, "/api/v1/ai/markdown", `{"post_id":"`+postID+`"}`, "").Code)
	assert.Equal(t, http.StatusUnauthorized, h.call(http.MethodGet, "/api/v1/ai/status", "", "").Code)
	assert.Zero(t, h.llm.calls.Load())
}

func TestStatusReportsEnabled(t *testing.T) {
	h := setup(t, "x", nil)
	assert.Equal(t, map[string]any{"enabled": true}, decode(t, h.call(http.MethodGet, "/api/v1/ai/status", "", userID)))
	h = setup(t, "x", func(c *configuration) { c.EnableAIMarkdown = false })
	assert.Equal(t, map[string]any{"enabled": false}, decode(t, h.call(http.MethodGet, "/api/v1/ai/status", "", userID)))
}

func TestDisabledReturns404WithoutCallingModel(t *testing.T) {
	h := setup(t, "x", func(c *configuration) { c.EnableAIMarkdown = false })
	assert.Equal(t, http.StatusNotFound, h.convert().Code)
	assert.Zero(t, h.llm.calls.Load())
}

func TestBadRequest(t *testing.T) {
	h := setup(t, "x", nil)
	for _, body := range []string{``, `{}`, `{"post_id":"short"}`, `{"text":"free prompt"}`} {
		assert.Equal(t, http.StatusBadRequest, h.call(http.MethodPost, "/api/v1/ai/markdown", body, userID).Code, body)
	}
	assert.Zero(t, h.llm.calls.Load())
}

func TestNoChannelPermissionLooksLikeMissingPost(t *testing.T) {
	h := setup(t, "secret", nil)
	other := "oooooooooooooooooooooooooo"
	h.api.On("HasPermissionToChannel", other, channelID, model.PermissionReadChannelContent).Return(false)
	w := h.call(http.MethodPost, "/api/v1/ai/markdown", `{"post_id":"`+postID+`"}`, other)
	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.NotContains(t, w.Body.String(), "secret")
	assert.Zero(t, h.llm.calls.Load())
}

func TestTooLong(t *testing.T) {
	h := setup(t, strings.Repeat("ا", 600), func(c *configuration) { c.MaxInputChars = 500 })
	assert.Equal(t, http.StatusRequestEntityTooLarge, h.convert().Code)
	assert.Zero(t, h.llm.calls.Load())
}

func TestConvertSendsSafeRequestAndCaches(t *testing.T) {
	h := setup(t, "علت 401:\n\nاقدام تیم: دوباره لاگین کنند.", nil)
	h.llm.reply = "<think>hmm</think>\n```markdown\n# علت 401\n\n**اقدام تیم:** دوباره لاگین کنند.\n```"
	w := h.convert()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, map[string]any{"markdown": "# علت 401\n\n**اقدام تیم:** دوباره لاگین کنند.", "cached": false}, decode(t, w))

	req := h.llm.last
	assert.Equal(t, "Bearer "+testKey, h.llm.auth)
	assert.Equal(t, "qwen", req.Model)
	assert.False(t, req.Stream)
	assert.Equal(t, map[string]any{"enable_thinking": false}, req.ChatTemplateKwargs)
	assert.Positive(t, req.MaxTokens)
	assert.LessOrEqual(t, req.MaxTokens, defaultMaxOutputTokens)
	assert.Equal(t, "system", req.Messages[0].Role)
	assert.Equal(t, "<message>\nعلت 401:\n\nاقدام تیم: دوباره لاگین کنند.\n</message>", req.Messages[1].Content)
	h.api.AssertCalled(t, "KVSetWithOptions", mock.MatchedBy(func(k string) bool { return strings.HasPrefix(k, "mdai_v1_") }),
		[]byte("# علت 401\n\n**اقدام تیم:** دوباره لاگین کنند."), model.PluginKVSetOptions{ExpireInSeconds: int64(cacheTTL.Seconds())})
	assert.NotContains(t, w.Body.String(), testKey)
}

func TestCacheHitSkipsModel(t *testing.T) {
	h := setup(t, "x", nil)
	h.api.ExpectedCalls = filterOut(h.api.ExpectedCalls, "KVGet")
	h.api.On("KVGet", mock.Anything).Return([]byte("# cached"), nil)
	w := h.convert()
	assert.Equal(t, map[string]any{"markdown": "# cached", "cached": true}, decode(t, w))
	assert.Zero(t, h.llm.calls.Load())
}

func TestRateLimitPerUser(t *testing.T) {
	h := setup(t, "x", func(c *configuration) { c.RateLimitPerMinute = 2 })
	assert.Equal(t, http.StatusOK, h.convert().Code)
	assert.Equal(t, http.StatusOK, h.convert().Code)
	w := h.convert()
	assert.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.NotEmpty(t, w.Header().Get("Retry-After"))
	assert.EqualValues(t, 2, h.llm.calls.Load())
}

func TestUpstreamErrorDoesNotLeakPrompt(t *testing.T) {
	h := setup(t, "private text", nil)
	h.llm.status = http.StatusInternalServerError
	w := h.convert()
	assert.Equal(t, http.StatusBadGateway, w.Code)
	assert.NotContains(t, w.Body.String(), "private text")
}

func TestTimeout(t *testing.T) {
	h := setup(t, "x", nil)
	h.p.config.TimeoutSeconds = 1
	h.llm.delay = 3 * time.Second
	w := h.convert()
	assert.Equal(t, http.StatusGatewayTimeout, w.Code)
}

func TestTruncatedOutputIsFlagged(t *testing.T) {
	h := setup(t, "x", nil)
	h.llm.finish = "length"
	m := decode(t, h.convert())
	assert.Equal(t, true, m["truncated"])
	h.api.AssertNotCalled(t, "KVSetWithOptions", mock.Anything, mock.Anything, mock.Anything)
}

func TestBusyWhenTheSlotIsTaken(t *testing.T) {
	h := setup(t, "x", nil)
	h.p.slot <- struct{}{} // another conversion is running
	done := make(chan int)
	go func() { done <- h.convert().Code }()
	select {
	case code := <-done:
		t.Fatalf("returned %d before the wait expired", code)
	case <-time.After(200 * time.Millisecond):
	}
	<-h.p.slot // the other conversion finishes
	assert.Equal(t, http.StatusOK, <-done)
}

func TestNormalizedClampsLimits(t *testing.T) {
	c := configuration{MaxOutputTokens: 999999, TimeoutSeconds: 1, RateLimitPerMinute: -5, MaxInputChars: 0, LiteLLMBaseURL: " https://x/v1/ "}.normalized()
	assert.Equal(t, 8000, c.MaxOutputTokens)
	assert.Equal(t, 10, c.TimeoutSeconds)
	assert.Equal(t, defaultRateLimit, c.RateLimitPerMinute)
	assert.Equal(t, defaultMaxInputChars, c.MaxInputChars)
	assert.Equal(t, "https://x/v1", c.LiteLLMBaseURL)
	assert.Equal(t, "qwen", c.LiteLLMModel)
	assert.Error(t, configuration{EnableAIMarkdown: true, LiteLLMBaseURL: "file:///etc/passwd"}.validate())
	assert.NoError(t, configuration{EnableAIMarkdown: true, LiteLLMBaseURL: defaultBaseURL}.validate())
}

func TestCleanOutputAndBudget(t *testing.T) {
	assert.Equal(t, "# a", cleanOutput("```md\n# a\n```"))
	assert.Equal(t, "# a\n\n```js\nx\n```", cleanOutput("# a\n\n```js\nx\n```"))
	assert.Equal(t, "ok", cleanOutput("<think>\nlong\n</think>\nok"))
	assert.Equal(t, 400, outputBudget("", 4000))
	assert.Equal(t, 4000, outputBudget(strings.Repeat("ا", 100000), 4000))
}

func TestCacheKeyChangesOnEdit(t *testing.T) {
	cfg := configuration{LiteLLMModel: "qwen"}
	a := cacheKey(cfg, &model.Post{Id: postID, EditAt: 1})
	b := cacheKey(cfg, &model.Post{Id: postID, EditAt: 2})
	assert.NotEqual(t, a, b)
	assert.LessOrEqual(t, len(a), 50)
}

func filterOut(calls []*mock.Call, method string) []*mock.Call {
	out := calls[:0]
	for _, c := range calls {
		if c.Method != method {
			out = append(out, c)
		}
	}
	return out
}
