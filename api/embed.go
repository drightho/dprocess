// Package apispec embeds the OpenAPI document so the server can publish it.
package apispec

import _ "embed"

// OpenAPI is the OpenAPI 3 description of the REST API.
//
//go:embed openapi.yaml
var OpenAPI []byte
