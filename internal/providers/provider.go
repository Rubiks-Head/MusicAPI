package providers

import (
	"context"
	"net/http"
	"sort"
	"time"

	"musicapi/internal/core"
)

type Provider interface {
	Name() string
	Cfgd() bool
	Srch(ctx context.Context, query string, limit, offset int) (core.SearchResult, error)
	Trk(ctx context.Context, id string) (core.Track, error)
	Art(ctx context.Context, id string) (core.Artist, error)
}

type Streamer interface {
	Strm(ctx context.Context, id string) (string, error)
}

type Playlister interface {
	Pl(ctx context.Context, id string) (core.Playlist, error)
}

type Status struct {
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
}

type Registry struct {
	all map[string]Provider
}

func NewReg(ps ...Provider) *Registry {
	r := &Registry{all: make(map[string]Provider, len(ps))}
	for _, p := range ps {
		r.all[p.Name()] = p
	}
	return r
}

func (r *Registry) Get(name string) (Provider, bool) {
	p, ok := r.all[name]
	return p, ok
}

func (r *Registry) Cfgd() []Provider {
	out := make([]Provider, 0, len(r.all))
	for _, p := range r.all {
		if p.Cfgd() {
			out = append(out, p)
		}
	}
	return out
}

func (r *Registry) Stat() []Status {
	out := make([]Status, 0, len(r.all))
	for _, p := range r.all {
		out = append(out, Status{Name: p.Name(), Configured: p.Cfgd()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func client() *http.Client {
	return &http.Client{Timeout: 10 * time.Second}
}
