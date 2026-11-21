//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"strconv"
	"syscall/js"
	"time"

	"musicapi/internal/engine"
)

var eng *engine.Engine

func exp(name string, fn func([]js.Value) (any, error)) {
	js.Global().Set(name, js.FuncOf(func(this js.Value, args []js.Value) any {
		return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, pa []js.Value) any {
			resolve := pa[0]
			go func() {
				out, err := fn(args)
				if err != nil {
					code := "internal"
					if ee, ok := err.(*engine.Error); ok {
						code = ee.Code
					}
					b, _ := json.Marshal(map[string]any{
						"ok":    false,
						"error": map[string]string{"code": code, "message": err.Error()},
					})
					resolve.Invoke(string(b))
					return
				}
				b, _ := json.Marshal(map[string]any{"ok": true, "data": out})
				resolve.Invoke(string(b))
			}()
			return nil
		}))
	}))
}

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 60*time.Second)
}

func main() {
	exp("mInit", func(args []js.Value) (any, error) {
		e, err := engine.New(json.RawMessage(args[0].String()))
		if err != nil {
			return nil, err
		}
		eng = e
		return "ok", nil
	})
	exp("mSrch", func(args []js.Value) (any, error) {
		limit, _ := strconv.Atoi(args[2].String())
		offset, _ := strconv.Atoi(args[3].String())
		c, cancel := ctx()
		defer cancel()
		return eng.Srch(c, args[0].String(), args[1].String(), limit, offset)
	})
	exp("mTrk", func(args []js.Value) (any, error) {
		c, cancel := ctx()
		defer cancel()
		return eng.Trk(c, args[0].String(), args[1].String())
	})
	exp("mArt", func(args []js.Value) (any, error) {
		c, cancel := ctx()
		defer cancel()
		return eng.Art(c, args[0].String(), args[1].String())
	})
	exp("mLyr", func(args []js.Value) (any, error) {
		c, cancel := ctx()
		defer cancel()
		return eng.Lyrics(c, args[0].String(), args[1].String())
	})
	exp("mPl", func(args []js.Value) (any, error) {
		c, cancel := ctx()
		defer cancel()
		return eng.Pl(c, args[0].String(), args[1].String())
	})
	exp("mStrm", func(args []js.Value) (any, error) {
		c, cancel := ctx()
		defer cancel()
		return eng.Strm(c, args[0].String(), args[1].String())
	})
	exp("mStat", func(args []js.Value) (any, error) {
		return eng.Stat()
	})
	js.Global().Set("__musicReady", true)
	select {}
}
