package core

type Track struct {
	ID         string   `json:"id"`
	Source     string   `json:"source"`
	Title      string   `json:"title"`
	Artists    []string `json:"artists"`
	Album      string   `json:"album,omitempty"`
	DurationMS int64    `json:"duration_ms,omitempty"`
	Artwork    string   `json:"artwork_url,omitempty"`
	URL        string   `json:"url,omitempty"`
	PreviewURL string   `json:"preview_url,omitempty"`
	FileID     string   `json:"file_id,omitempty"`
}

type Playlist struct {
	ID          string  `json:"id"`
	Source      string  `json:"source"`
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Image       string  `json:"image_url,omitempty"`
	Tracks      []Track `json:"tracks"`
}

type Artist struct {
	ID      string   `json:"id"`
	Source  string   `json:"source"`
	Name    string   `json:"name"`
	Genres  []string `json:"genres,omitempty"`
	Artwork string   `json:"artwork_url,omitempty"`
	URL     string   `json:"url,omitempty"`
}

type Lyrics struct {
	Track  string `json:"track"`
	Artist string `json:"artist"`
	Album  string `json:"album,omitempty"`
	Plain  string `json:"plain_lyrics,omitempty"`
	Synced string `json:"synced_lyrics,omitempty"`
	Source string `json:"source"`
}

type SearchResult struct {
	Query   string   `json:"query"`
	Tracks  []Track  `json:"tracks"`
	Artists []Artist `json:"artists"`
}
