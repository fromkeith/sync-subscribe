module github.com/fromkeith/sync-subscribe/packages/server-go

go 1.22

// During local development the go.work file at the repo root resolves this
// to ../core-go automatically. For published releases, this require is updated
// by the publish workflow (see .github/workflows/publish.yml).
require github.com/fromkeith/sync-subscribe/packages/core-go v0.0.0
