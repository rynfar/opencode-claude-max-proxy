# Changelog

## [1.7.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.0...v1.7.1) (2026-03-20)


### Bug Fixes

* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))

## [1.7.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.6.1...v1.7.0) (2026-03-20)


### Features

* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/opencode-claude-max-proxy/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))


### Bug Fixes

* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/opencode-claude-max-proxy/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))

## [1.6.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.6.0...v1.6.1) (2026-03-20)


### Bug Fixes

* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/opencode-claude-max-proxy/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)

## [1.6.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.5.0...v1.6.0) (2026-03-20)


### Features

* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))


### Bug Fixes

* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/opencode-claude-max-proxy/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/opencode-claude-max-proxy/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))

## [1.5.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.4.0...v1.5.0) (2026-03-20)


### Features

* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/opencode-claude-max-proxy/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/opencode-claude-max-proxy/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/opencode-claude-max-proxy/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/opencode-claude-max-proxy/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/opencode-claude-max-proxy/issues/21)
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/opencode-claude-max-proxy/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))

## [1.4.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.3.0...v1.4.0) (2026-03-20)


### Features

* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/opencode-claude-max-proxy/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/opencode-claude-max-proxy/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/opencode-claude-max-proxy/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7cb37b66051b26058baf500da035ac600f51b8b9))

## [1.3.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.2.0...v1.3.0) (2026-03-20)


### Features

* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/opencode-claude-max-proxy/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/opencode-claude-max-proxy/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))


### Bug Fixes

* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/opencode-claude-max-proxy/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/opencode-claude-max-proxy/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/opencode-claude-max-proxy/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/opencode-claude-max-proxy/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/opencode-claude-max-proxy/issues/18)

## [1.2.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.1.1...v1.2.0) (2026-03-20)


### Features

* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/opencode-claude-max-proxy/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/opencode-claude-max-proxy/commit/34452a332c91c047812b0073b576807d1c106dfd))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/opencode-claude-max-proxy/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/opencode-claude-max-proxy/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/opencode-claude-max-proxy/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))


### Bug Fixes

* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/64133e1928836faf3d5347188183e540209ae8ca))
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/opencode-claude-max-proxy/commit/18a02805680c29c96dd53788601577c78c709b33))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/opencode-claude-max-proxy/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/opencode-claude-max-proxy/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))

## [1.1.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.1.0...v1.1.1) (2026-03-20)


### Bug Fixes

* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/opencode-claude-max-proxy/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/opencode-claude-max-proxy/issues/16)

## [1.1.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.2...v1.1.0) (2026-03-19)


### Features

* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))


### Bug Fixes

* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.0.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.1...v1.0.2) (2026-01-26)


### Bug Fixes

* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))

## [1.0.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.0...v1.0.1) (2026-01-26)


### Bug Fixes

* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))

## 1.0.0 (2026-01-26)


### Features

* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))


### Bug Fixes

* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
