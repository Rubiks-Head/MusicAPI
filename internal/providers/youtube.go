package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"musicapi/internal/core"
)

type YouTube struct {
	web   string
	http  *http.Client
	mu    sync.Mutex
	itKey string
	itVer string
	itAt  time.Time
}

func NewYT(web string) *YouTube {
	return &YouTube{web: web, http: client()}
}

func (y *YouTube) Name() string { return "youtube" }
func (y *YouTube) Cfgd() bool   { return true }

var (
	itKeyRe = regexp.MustCompile(`"INNERTUBE_API_KEY":"([^"]+)"`)
	itVerRe = regexp.MustCompile(`"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"`)
)

func (y *YouTube) it(ctx context.Context) (string, string, error) {
	y.mu.Lock()
	defer y.mu.Unlock()
	if y.itKey != "" && time.Since(y.itAt) < 24*time.Hour {
		return y.itKey, y.itVer, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, y.web, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	resp, err := y.http.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	k, v := itKeyRe.FindSubmatch(body), itVerRe.FindSubmatch(body)
	if len(k) < 2 || len(v) < 2 {
		return "", "", fmt.Errorf("youtube: it key not found")
	}
	y.itKey, y.itVer, y.itAt = string(k[1]), string(v[1]), time.Now()
	return y.itKey, y.itVer, nil
}

func (y *YouTube) post(ctx context.Context, ep string, body map[string]any, out any) error {
	key, ver, err := y.it(ctx)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"context": map[string]any{
			"client": map[string]any{"clientName": "WEB", "clientVersion": ver},
		},
	}
	for k, v := range body {
		payload[k] = v
	}
	buf, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/youtubei/v1/%s?key=%s", y.web, ep, key), bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	resp, err := y.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("youtube %s: %s", ep, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type itRuns struct {
	Text string `json:"simpleText"`
	Runs []struct {
		Text string `json:"text"`
	} `json:"runs"`
}

func (r itRuns) String() string {
	if r.Text != "" {
		return r.Text
	}
	if len(r.Runs) > 0 {
		return r.Runs[0].Text
	}
	return ""
}

type itThumbs struct {
	Thumbnails []struct {
		URL string `json:"url"`
	} `json:"thumbnails"`
}

func (t itThumbs) URL() string {
	if len(t.Thumbnails) == 0 {
		return ""
	}
	return t.Thumbnails[len(t.Thumbnails)-1].URL
}

func clock(s string) int64 {
	parts := strings.Split(s, ":")
	var ms int64
	for _, p := range parts {
		n, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return 0
		}
		ms = ms*60 + n
	}
	return ms * 1000
}

type itVideo struct {
	VideoID string   `json:"videoId"`
	Title   itRuns   `json:"title"`
	Owner   itRuns   `json:"ownerText"`
	Len     itRuns   `json:"lengthText"`
	Thumb   itThumbs `json:"thumbnail"`
}

type itChannel struct {
	ChannelID string   `json:"channelId"`
	Title     itRuns   `json:"title"`
	Thumb     itThumbs `json:"thumbnail"`
	Desc      itRuns   `json:"descriptionSnippet"`
}

func (v *itVideo) trk() core.Track {
	return core.Track{
		ID:         v.VideoID,
		Source:     "youtube",
		Title:      v.Title.String(),
		Artists:    []string{v.Owner.String()},
		DurationMS: clock(v.Len.String()),
		Artwork:    v.Thumb.URL(),
		URL:        "https://www.youtube.com/watch?v=" + v.VideoID,
	}
}

type itSection struct {
	Item struct {
		Contents []struct {
			Video   *itVideo   `json:"videoRenderer"`
			Channel *itChannel `json:"channelRenderer"`
		} `json:"contents"`
	} `json:"itemSectionRenderer"`
	Cont struct {
		Endpoint struct {
			Cmd struct {
				Token string `json:"token"`
			} `json:"continuationCommand"`
		} `json:"continuationEndpoint"`
	} `json:"continuationItemRenderer"`
}

func (s itSection) tok() string { return s.Cont.Endpoint.Cmd.Token }

func (y *YouTube) page(ctx context.Context, body map[string]any, first bool) ([]itSection, error) {
	var sections []itSection
	if first {
		var out struct {
			Contents struct {
				TwoCol struct {
					Primary struct {
						Section struct {
							Contents []itSection `json:"contents"`
						} `json:"sectionListRenderer"`
					} `json:"primaryContents"`
				} `json:"twoColumnSearchResultsRenderer"`
			} `json:"contents"`
		}
		if err := y.post(ctx, "search", body, &out); err != nil {
			return nil, err
		}
		return out.Contents.TwoCol.Primary.Section.Contents, nil
	}
	var out struct {
		Commands []struct {
			Append struct {
				Items []itSection `json:"continuationItems"`
			} `json:"appendContinuationItemsAction"`
		} `json:"onResponseReceivedCommands"`
	}
	if err := y.post(ctx, "search", body, &out); err != nil {
		return nil, err
	}
	for _, c := range out.Commands {
		sections = append(sections, c.Append.Items...)
	}
	return sections, nil
}

func (y *YouTube) Srch(ctx context.Context, query string, limit, offset int) (core.SearchResult, error) {
	res := core.SearchResult{Query: query}
	body := map[string]any{"query": query}
	first, token := true, ""
	for page := 0; page < 3 && len(res.Tracks) < offset+limit; page++ {
		if !first {
			if token == "" {
				break
			}
			body = map[string]any{"continuation": token}
		}
		sections, err := y.page(ctx, body, first)
		if err != nil {
			if page == 0 {
				return res, err
			}
			break
		}
		first, token = false, ""
		for _, s := range sections {
			if t := s.tok(); t != "" {
				token = t
				continue
			}
			for _, it := range s.Item.Contents {
				if it.Video != nil && it.Video.VideoID != "" {
					res.Tracks = append(res.Tracks, it.Video.trk())
				}
				if it.Channel != nil && it.Channel.ChannelID != "" {
					res.Artists = append(res.Artists, core.Artist{
						ID:      it.Channel.ChannelID,
						Source:  y.Name(),
						Name:    it.Channel.Title.String(),
						Artwork: it.Channel.Thumb.URL(),
						URL:     "https://www.youtube.com/channel/" + it.Channel.ChannelID,
					})
				}
			}
		}
	}
	if offset < len(res.Tracks) {
		res.Tracks = res.Tracks[offset:]
	} else {
		res.Tracks = nil
	}
	if len(res.Tracks) > limit {
		res.Tracks = res.Tracks[:limit]
	}
	return res, nil
}

func (y *YouTube) Trk(ctx context.Context, id string) (core.Track, error) {
	var body struct {
		VideoDetails struct {
			VideoID       string   `json:"videoId"`
			Title         string   `json:"title"`
			Author        string   `json:"author"`
			LengthSeconds string   `json:"lengthSeconds"`
			Thumb         itThumbs `json:"thumbnail"`
		} `json:"videoDetails"`
	}
	if err := y.post(ctx, "player", map[string]any{"videoId": id}, &body); err != nil {
		return core.Track{}, err
	}
	v := body.VideoDetails
	if v.VideoID == "" {
		return core.Track{}, fmt.Errorf("youtube: video %s not found", id)
	}
	sec, _ := strconv.ParseInt(v.LengthSeconds, 10, 64)
	return core.Track{
		ID:         v.VideoID,
		Source:     y.Name(),
		Title:      v.Title,
		Artists:    []string{v.Author},
		DurationMS: sec * 1000,
		Artwork:    v.Thumb.URL(),
		URL:        "https://www.youtube.com/watch?v=" + v.VideoID,
	}, nil
}

func (y *YouTube) Art(ctx context.Context, id string) (core.Artist, error) {
	var body struct {
		Header struct {
			C4 struct {
				Title  string   `json:"title"`
				Avatar itThumbs `json:"avatar"`
			} `json:"c4TabbedHeaderRenderer"`
			PageHeader struct {
				PageTitle string `json:"pageTitle"`
				Content   struct {
					VM struct {
						Image struct {
							Avatar struct {
								VM struct {
									Image itThumbs `json:"image"`
								} `json:"avatarViewModel"`
							} `json:"decoratedAvatarViewModel"`
						} `json:"image"`
					} `json:"pageHeaderViewModel"`
				} `json:"content"`
			} `json:"pageHeaderRenderer"`
		} `json:"header"`
	}
	if err := y.post(ctx, "browse", map[string]any{"browseId": id}, &body); err != nil {
		return core.Artist{}, err
	}
	name, art := body.Header.C4.Title, body.Header.C4.Avatar.URL()
	if name == "" {
		name = body.Header.PageHeader.PageTitle
	}
	if art == "" {
		art = body.Header.PageHeader.Content.VM.Image.Avatar.VM.Image.URL()
	}
	if name == "" {
		return core.Artist{}, fmt.Errorf("youtube: channel %s not found", id)
	}
	return core.Artist{
		ID:      id,
		Source:  y.Name(),
		Name:    name,
		Artwork: art,
		URL:     "https://www.youtube.com/channel/" + id,
	}, nil
}
