package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

const (
	alice = "aaaaaaaaaaaaaaaaaaaaaaaaaa" // requester, author of the posts
	bob   = "bbbbbbbbbbbbbbbbbbbbbbbbbb" // acknowledged, viewed late
	carol = "cccccccccccccccccccccccccd" // acknowledged, viewed early
	dave  = "dddddddddddddddddddddddddd" // never acknowledged, viewed late
	robot = "rrrrrrrrrrrrrrrrrrrrrrrrrr" // bot
	ch    = "hhhhhhhhhhhhhhhhhhhhhhhhhh"
	p1    = "11111111111111111111111111" // alice, t=100
	p2    = "22222222222222222222222222" // alice, t=300
	pBob  = "33333333333333333333333333" // bob's own post
)

func receiptsHarness(t *testing.T, acked ...string) (*Plugin, *plugintest.API) {
	api := &plugintest.API{}
	api.On("LogInfo", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Maybe()
	api.On("LogWarn", mock.Anything, mock.Anything, mock.Anything).Maybe()
	keys := []string{"mdai_v1_x"}
	for _, u := range acked {
		keys = append(keys, ackKeyPrefix+u)
	}
	api.On("KVList", 0, 1000).Return(keys, nil).Maybe()
	api.On("KVGet", mock.Anything).Return(nil, nil).Maybe()
	api.On("KVSet", mock.Anything, mock.Anything).Return(nil).Maybe()
	api.On("HasPermissionToChannel", mock.Anything, ch, model.PermissionReadChannelContent).Return(true).Maybe()
	api.On("GetPost", p1).Return(&model.Post{Id: p1, UserId: alice, ChannelId: ch, CreateAt: 100}, nil).Maybe()
	api.On("GetPost", p2).Return(&model.Post{Id: p2, UserId: alice, ChannelId: ch, CreateAt: 300}, nil).Maybe()
	api.On("GetPost", pBob).Return(&model.Post{Id: pBob, UserId: bob, ChannelId: ch, CreateAt: 100}, nil).Maybe()
	api.On("GetChannelStats", ch).Return(&model.ChannelStats{ChannelId: ch, MemberCount: 5}, nil).Maybe()
	api.On("GetUsersInChannel", ch, model.ChannelSortByUsername, 0, 200).Return([]*model.User{
		{Id: alice}, {Id: bob}, {Id: carol}, {Id: dave}, {Id: robot, IsBot: true},
	}, nil).Maybe()
	api.On("GetChannelMembers", ch, 0, 200).Return(model.ChannelMembers{
		{UserId: alice, LastViewedAt: 999},
		{UserId: bob, LastViewedAt: 500},
		{UserId: carol, LastViewedAt: 200},
		{UserId: dave, LastViewedAt: 500},
		{UserId: robot, LastViewedAt: 999},
	}, nil).Maybe()

	p := &Plugin{}
	p.SetAPI(api)
	require.NoError(t, p.OnActivate())
	p.config = configuration{EnableReadReceipts: true}.normalized()
	return p, api
}

func receiptsCall(p *Plugin, body, user string) map[string]any {
	h := &harness{p: p}
	w := h.call(http.MethodPost, "/api/v1/receipts", body, user)
	m := map[string]any{"_code": w.Code}
	_ = jsonUnmarshal(w.Body.Bytes(), &m)
	return m
}

func TestReceiptsDisabledByDefault(t *testing.T) {
	p, _ := receiptsHarness(t, alice, bob)
	p.config = configuration{}.normalized()
	m := receiptsCall(p, `{"channel_id":"`+ch+`","post_ids":["`+p1+`"]}`, alice)
	assert.Equal(t, http.StatusNotFound, m["_code"])
}

func TestReceiptsRequireRequesterNotice(t *testing.T) {
	p, _ := receiptsHarness(t, bob) // alice has not acknowledged
	m := receiptsCall(p, `{"channel_id":"`+ch+`","post_ids":["`+p1+`"]}`, alice)
	assert.Equal(t, http.StatusForbidden, m["_code"])
	assert.Equal(t, "notice_required", m["error"])
}

func TestReceiptsCountOnlyAcknowledgedHumansWhoViewedAfterThePost(t *testing.T) {
	p, _ := receiptsHarness(t, alice, bob, carol)
	m := receiptsCall(p, `{"channel_id":"`+ch+`","post_ids":["`+p1+`","`+p2+`","`+pBob+`"]}`, alice)
	require.Equal(t, http.StatusOK, m["_code"])
	assert.EqualValues(t, 3, m["members"], "bob, carol, dave; not alice, not the bot")
	posts := m["posts"].(map[string]any)
	// p1 at t=100: bob (500) and carol (200) saw it; dave saw it but never acknowledged.
	assert.Equal(t, map[string]any{"seen": float64(2), "by": []any{bob, carol}}, posts[p1])
	// p2 at t=300: only bob.
	assert.Equal(t, map[string]any{"seen": float64(1), "by": []any{bob}}, posts[p2])
	// Someone else's post is ignored.
	assert.NotContains(t, posts, pBob)
	assert.NotContains(t, m, "last_viewed_at")
}

func TestReceiptsNeverReturnTimestamps(t *testing.T) {
	p, _ := receiptsHarness(t, alice, bob, carol)
	h := &harness{p: p}
	w := h.call(http.MethodPost, "/api/v1/receipts", `{"channel_id":"`+ch+`","post_ids":["`+p1+`"]}`, alice)
	assert.NotContains(t, w.Body.String(), "500")
	assert.NotContains(t, w.Body.String(), "200,")
}

func TestReceiptsNoChannelAccess(t *testing.T) {
	p, api := receiptsHarness(t, alice, "eeeeeeeeeeeeeeeeeeeeeeeeee")
	stranger := "eeeeeeeeeeeeeeeeeeeeeeeeee"
	api.ExpectedCalls = filterOut(api.ExpectedCalls, "HasPermissionToChannel")
	api.On("HasPermissionToChannel", stranger, ch, model.PermissionReadChannelContent).Return(false)
	m := receiptsCall(p, `{"channel_id":"`+ch+`","post_ids":["`+p1+`"]}`, stranger)
	assert.Equal(t, http.StatusNotFound, m["_code"])
}

func TestReceiptsLargeChannel(t *testing.T) {
	p, _ := receiptsHarness(t, alice)
	p.config.ReceiptsMaxMembers = 3
	m := receiptsCall(p, `{"channel_id":"`+ch+`","post_ids":["`+p1+`"]}`, alice)
	assert.Equal(t, true, m["too_large"])
}

func TestReceiptsBadRequests(t *testing.T) {
	p, _ := receiptsHarness(t, alice)
	many := `"` + strings.Repeat(p1+`","`, maxPostsPerRequest) + p1 + `"`
	for _, body := range []string{`{}`, `{"channel_id":"x","post_ids":["` + p1 + `"]}`, `{"channel_id":"` + ch + `","post_ids":[]}`, `{"channel_id":"` + ch + `","post_ids":[` + many + `]}`} {
		assert.Equal(t, http.StatusBadRequest, receiptsCall(p, body, alice)["_code"], body)
	}
}

func TestReceiptsAckAndStatus(t *testing.T) {
	p, api := receiptsHarness(t)
	h := &harness{p: p}
	st := decode(t, h.call(http.MethodGet, "/api/v1/receipts/status", "", alice))
	assert.Equal(t, false, st["acknowledged"])
	assert.Equal(t, true, st["enabled"])

	w := h.call(http.MethodPost, "/api/v1/receipts/ack", "", alice)
	require.Equal(t, http.StatusOK, w.Code)
	api.AssertCalled(t, "KVSet", ackKeyPrefix+alice, mock.Anything)
	st = decode(t, h.call(http.MethodGet, "/api/v1/receipts/status", "", alice))
	assert.Equal(t, true, st["acknowledged"])

	p.config = configuration{}.normalized()
	assert.Equal(t, http.StatusNotFound, h.call(http.MethodPost, "/api/v1/receipts/ack", "", alice).Code)
	st = decode(t, h.call(http.MethodGet, "/api/v1/receipts/status", "", alice))
	assert.Equal(t, false, st["enabled"])
}

func TestReceiptsSnapshotIsShared(t *testing.T) {
	p, api := receiptsHarness(t, alice, bob)
	body := `{"channel_id":"` + ch + `","post_ids":["` + p1 + `"]}`
	receiptsCall(p, body, alice)
	receiptsCall(p, body, alice)
	api.AssertNumberOfCalls(t, "GetChannelMembers", 1)
}
