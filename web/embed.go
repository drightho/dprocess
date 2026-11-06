// Package web embeds the built single-page application (web/dist).
package web

import (
	"embed"
	"io/fs"
)

// dist always contains at least a .gitkeep placeholder, so the package
// compiles before the UI has been built (`make web`).
//
//go:embed all:dist
var dist embed.FS

// FS returns the built UI rooted at the dist directory.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // dist is embedded at build time; cannot fail
	}
	return sub
}
