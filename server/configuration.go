package main

import (
	"fmt"
	"net/url"
	"strings"
)

// configuration mirrors settings_schema in plugin.json. Values are set by a
// system admin in System Console → Plugins → Mattermost RTL.
type configuration struct {
	EnableAIMarkdown   bool
	LiteLLMBaseURL     string
	LiteLLMAPIKey      string
	LiteLLMModel       string
	MaxOutputTokens    int
	TimeoutSeconds     int
	RateLimitPerMinute int
	MaxInputChars      int
	ExtraInstructions  string

	EnableReadReceipts bool
	ReceiptsMaxMembers int
}

const (
	defaultModel           = "qwen"
	defaultMaxOutputTokens = 4000
	defaultTimeoutSeconds  = 60
	defaultRateLimit       = 6
	defaultMaxInputChars   = 8000
	defaultReceiptsMax     = 200
)

// normalized fills defaults and clamps values so a bad setting can't remove
// the safety limits (the model serves one request at a time).
func (c configuration) normalized() configuration {
	c.LiteLLMBaseURL = strings.TrimRight(strings.TrimSpace(c.LiteLLMBaseURL), "/")
	c.LiteLLMAPIKey = strings.TrimSpace(c.LiteLLMAPIKey)
	c.LiteLLMModel = strings.TrimSpace(c.LiteLLMModel)
	if c.LiteLLMModel == "" {
		c.LiteLLMModel = defaultModel
	}
	c.MaxOutputTokens = clamp(c.MaxOutputTokens, defaultMaxOutputTokens, 256, 8000)
	c.TimeoutSeconds = clamp(c.TimeoutSeconds, defaultTimeoutSeconds, 10, 300)
	c.RateLimitPerMinute = clamp(c.RateLimitPerMinute, defaultRateLimit, 1, 60)
	c.MaxInputChars = clamp(c.MaxInputChars, defaultMaxInputChars, 500, 50000)
	c.ReceiptsMaxMembers = clamp(c.ReceiptsMaxMembers, defaultReceiptsMax, 2, 2000)
	c.ExtraInstructions = strings.TrimSpace(c.ExtraInstructions)
	if len([]rune(c.ExtraInstructions)) > 2000 {
		c.ExtraInstructions = string([]rune(c.ExtraInstructions)[:2000])
	}
	return c
}

// validate reports settings that make the AI feature unusable.
func (c configuration) validate() error {
	if !c.EnableAIMarkdown {
		return nil
	}
	if c.LiteLLMBaseURL == "" {
		return fmt.Errorf("set the LiteLLM base URL before enabling AI Markdown")
	}
	u, err := url.Parse(c.LiteLLMBaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("LiteLLM base URL must be an http(s) URL, got %q", c.LiteLLMBaseURL)
	}
	return nil
}

func clamp(v, def, lo, hi int) int {
	if v <= 0 {
		v = def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
