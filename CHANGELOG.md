# Changelog

## [1.24.0](https://github.com/rynfar/meridian/compare/v1.23.1...v1.24.0) (2026-04-01)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/meridian/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/meridian/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))
* add LiteLLM passthrough adapter ([#215](https://github.com/rynfar/meridian/issues/215)) ([beb5a5b](https://github.com/rynfar/meridian/commit/beb5a5bd0f7c38622d335b0711afb15ca93b8b4c))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/meridian/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/meridian/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/meridian/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/meridian/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/meridian/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/meridian/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/meridian/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/meridian/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/meridian/issues/81)
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/meridian/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/meridian/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/meridian/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/meridian/issues/183)) ([7395b1f](https://github.com/rynfar/meridian/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))
* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/meridian/issues/149)) ([1b56c0b](https://github.com/rynfar/meridian/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/meridian/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/meridian/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/meridian/issues/181)) ([b07d2d4](https://github.com/rynfar/meridian/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/meridian/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/meridian/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/meridian/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/meridian/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/meridian/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/meridian/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/meridian/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/meridian/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/meridian/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/meridian/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/meridian/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/meridian/issues/21)
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/meridian/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/meridian/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/meridian/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/meridian/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/meridian/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/meridian/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/meridian/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/meridian/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* show client model version in telemetry ([f77095f](https://github.com/rynfar/meridian/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/meridian/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/meridian/issues/169)
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/meridian/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/meridian/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/meridian/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/meridian/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/meridian/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))
* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/meridian/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/meridian/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/meridian/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/meridian/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/meridian/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/meridian/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/meridian/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/meridian/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/meridian/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/meridian/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/meridian/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/meridian/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/meridian/issues/145)) ([4a79701](https://github.com/rynfar/meridian/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))
* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/meridian/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/meridian/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/meridian/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/meridian/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/meridian/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/meridian/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/meridian/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/meridian/issues/69)
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/meridian/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/meridian/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/meridian/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/meridian/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/meridian/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/meridian/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/meridian/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/meridian/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/meridian/issues/185)) ([8bd9b48](https://github.com/rynfar/meridian/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/meridian/issues/168)
* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/meridian/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/meridian/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/meridian/issues/124)
* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/meridian/issues/142)) ([6888f32](https://github.com/rynfar/meridian/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/meridian/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/meridian/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/meridian/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/meridian/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/meridian/issues/123)
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/meridian/commit/18a02805680c29c96dd53788601577c78c709b33))
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/meridian/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/meridian/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/meridian/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/meridian/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/meridian/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/meridian/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/meridian/issues/154)) ([#158](https://github.com/rynfar/meridian/issues/158)) ([7c68ee6](https://github.com/rynfar/meridian/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/meridian/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/meridian/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/meridian/issues/70)
* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/meridian/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/meridian/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/meridian/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/meridian/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/meridian/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* npm publish with automation token ([230b185](https://github.com/rynfar/meridian/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/meridian/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/meridian/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/meridian/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/meridian/issues/49)
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/meridian/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/meridian/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/meridian/issues/125)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/meridian/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/meridian/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/meridian/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/meridian/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/meridian/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/meridian/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/meridian/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/meridian/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/meridian/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/meridian/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/meridian/issues/18)
* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))
* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/meridian/issues/141)) ([64b9a1d](https://github.com/rynfar/meridian/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/meridian/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/meridian/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/meridian/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/meridian/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/meridian/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/meridian/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/meridian/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/meridian/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/meridian/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/meridian/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/meridian/issues/156)) ([f0dd8dd](https://github.com/rynfar/meridian/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/meridian/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/meridian/commit/291e20f93f91dfe8942c84a38847926b20db7598))
* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/meridian/issues/153)) ([#159](https://github.com/rynfar/meridian/issues/159)) ([39f09ca](https://github.com/rynfar/meridian/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/meridian/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/meridian/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/meridian/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/meridian/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/meridian/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/meridian/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/meridian/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/meridian/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/meridian/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/meridian/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/meridian/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/meridian/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/meridian/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/meridian/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/meridian/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/meridian/issues/146)) ([67442c4](https://github.com/rynfar/meridian/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/meridian/issues/140)
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/meridian/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/meridian/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/meridian/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))
* session store test race condition on CI ([90f927d](https://github.com/rynfar/meridian/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/meridian/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/meridian/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/meridian/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/meridian/issues/16)
* skip file locking in session store tests ([875e136](https://github.com/rynfar/meridian/commit/875e136091ff4521364429c13db2a25907777b4a))
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/meridian/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/meridian/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/meridian/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/meridian/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/meridian/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/meridian/issues/171)
* trigger npm publish with token ([c603363](https://github.com/rynfar/meridian/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/meridian/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/meridian/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/meridian/issues/139)) ([7aee13c](https://github.com/rynfar/meridian/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))

## [1.23.1](https://github.com/rynfar/meridian/compare/v1.23.0...v1.23.1) (2026-04-01)


### Bug Fixes

* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))

## [1.23.0](https://github.com/rynfar/meridian/compare/v1.22.2...v1.23.0) (2026-04-01)


### Features

* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))

## [1.22.2](https://github.com/rynfar/meridian/compare/v1.22.1...v1.22.2) (2026-04-01)


### Bug Fixes

* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))

## [1.22.1](https://github.com/rynfar/meridian/compare/v1.22.0...v1.22.1) (2026-03-30)


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))

## [1.22.0](https://github.com/rynfar/meridian/compare/v1.21.1...v1.22.0) (2026-03-30)


### Features

* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))


### Bug Fixes

* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))

## [1.21.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.21.0...v1.21.1) (2026-03-29)


### Bug Fixes

* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/opencode-claude-max-proxy/issues/185)) ([8bd9b48](https://github.com/rynfar/opencode-claude-max-proxy/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/opencode-claude-max-proxy/issues/168)

## [1.21.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.20.0...v1.21.0) (2026-03-29)


### Features

* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/opencode-claude-max-proxy/issues/183)) ([7395b1f](https://github.com/rynfar/opencode-claude-max-proxy/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))

## [1.20.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.4...v1.20.0) (2026-03-29)


### Features

* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/opencode-claude-max-proxy/issues/181)) ([b07d2d4](https://github.com/rynfar/opencode-claude-max-proxy/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))

## [1.19.4](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.3...v1.19.4) (2026-03-29)


### Bug Fixes

* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/opencode-claude-max-proxy/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))

## [1.19.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.2...v1.19.3) (2026-03-29)


### Bug Fixes

* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/opencode-claude-max-proxy/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))

## [1.19.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.1...v1.19.2) (2026-03-28)


### Bug Fixes

* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/opencode-claude-max-proxy/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))

## [1.19.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.0...v1.19.1) (2026-03-28)


### Bug Fixes

* skip file locking in session store tests ([875e136](https://github.com/rynfar/opencode-claude-max-proxy/commit/875e136091ff4521364429c13db2a25907777b4a))

## [1.19.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.18.2...v1.19.0) (2026-03-27)


### Features

* show client model version in telemetry ([f77095f](https://github.com/rynfar/opencode-claude-max-proxy/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/opencode-claude-max-proxy/issues/169)


### Bug Fixes

* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/opencode-claude-max-proxy/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/opencode-claude-max-proxy/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/opencode-claude-max-proxy/issues/171)

## [1.18.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.18.1...v1.18.2) (2026-03-26)


### Bug Fixes

* session store test race condition on CI ([90f927d](https://github.com/rynfar/opencode-claude-max-proxy/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))

## [1.18.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.18.0...v1.18.1) (2026-03-26)


### Bug Fixes

* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/opencode-claude-max-proxy/issues/142)) ([6888f32](https://github.com/rynfar/opencode-claude-max-proxy/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/opencode-claude-max-proxy/issues/154)) ([#158](https://github.com/rynfar/opencode-claude-max-proxy/issues/158)) ([7c68ee6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/opencode-claude-max-proxy/issues/156)) ([f0dd8dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/opencode-claude-max-proxy/issues/153)) ([#159](https://github.com/rynfar/opencode-claude-max-proxy/issues/159)) ([39f09ca](https://github.com/rynfar/opencode-claude-max-proxy/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))

## [1.18.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.17.2...v1.18.0) (2026-03-26)


### Features

* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/opencode-claude-max-proxy/issues/149)) ([1b56c0b](https://github.com/rynfar/opencode-claude-max-proxy/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))

## [1.17.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.17.1...v1.17.2) (2026-03-25)


### Bug Fixes

* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/opencode-claude-max-proxy/issues/145)) ([4a79701](https://github.com/rynfar/opencode-claude-max-proxy/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/opencode-claude-max-proxy/issues/146)) ([67442c4](https://github.com/rynfar/opencode-claude-max-proxy/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/opencode-claude-max-proxy/issues/140)
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/opencode-claude-max-proxy/issues/139)) ([7aee13c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))

## [1.17.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.17.0...v1.17.1) (2026-03-25)


### Bug Fixes

* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/opencode-claude-max-proxy/issues/141)) ([64b9a1d](https://github.com/rynfar/opencode-claude-max-proxy/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))

## [1.17.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.16.2...v1.17.0) (2026-03-24)


### Features

* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/opencode-claude-max-proxy/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/opencode-claude-max-proxy/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))


### Bug Fixes

* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/opencode-claude-max-proxy/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))

## [1.16.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.16.1...v1.16.2) (2026-03-24)


### Bug Fixes

* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/opencode-claude-max-proxy/commit/291e20f93f91dfe8942c84a38847926b20db7598))

## [1.16.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.16.0...v1.16.1) (2026-03-24)


### Bug Fixes

* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/opencode-claude-max-proxy/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/opencode-claude-max-proxy/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/opencode-claude-max-proxy/issues/124)
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/opencode-claude-max-proxy/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/opencode-claude-max-proxy/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/opencode-claude-max-proxy/issues/123)
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/opencode-claude-max-proxy/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/opencode-claude-max-proxy/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/opencode-claude-max-proxy/issues/125)

## [1.16.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.3...v1.16.0) (2026-03-24)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/opencode-claude-max-proxy/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/opencode-claude-max-proxy/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/opencode-claude-max-proxy/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/opencode-claude-max-proxy/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/opencode-claude-max-proxy/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/opencode-claude-max-proxy/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/opencode-claude-max-proxy/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/opencode-claude-max-proxy/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/opencode-claude-max-proxy/issues/81)
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/opencode-claude-max-proxy/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/opencode-claude-max-proxy/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/opencode-claude-max-proxy/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/opencode-claude-max-proxy/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/opencode-claude-max-proxy/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/opencode-claude-max-proxy/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/opencode-claude-max-proxy/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/opencode-claude-max-proxy/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/opencode-claude-max-proxy/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/opencode-claude-max-proxy/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/opencode-claude-max-proxy/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/opencode-claude-max-proxy/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/opencode-claude-max-proxy/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/opencode-claude-max-proxy/issues/21)
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/opencode-claude-max-proxy/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/opencode-claude-max-proxy/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/opencode-claude-max-proxy/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/opencode-claude-max-proxy/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/opencode-claude-max-proxy/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/opencode-claude-max-proxy/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/opencode-claude-max-proxy/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/opencode-claude-max-proxy/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/opencode-claude-max-proxy/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/opencode-claude-max-proxy/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/opencode-claude-max-proxy/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/opencode-claude-max-proxy/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/opencode-claude-max-proxy/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/opencode-claude-max-proxy/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/opencode-claude-max-proxy/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/opencode-claude-max-proxy/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/opencode-claude-max-proxy/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/opencode-claude-max-proxy/issues/69)
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/opencode-claude-max-proxy/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/opencode-claude-max-proxy/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/opencode-claude-max-proxy/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/opencode-claude-max-proxy/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/opencode-claude-max-proxy/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/opencode-claude-max-proxy/commit/18a02805680c29c96dd53788601577c78c709b33))
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/opencode-claude-max-proxy/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/opencode-claude-max-proxy/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/opencode-claude-max-proxy/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/opencode-claude-max-proxy/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/opencode-claude-max-proxy/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/opencode-claude-max-proxy/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/opencode-claude-max-proxy/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/opencode-claude-max-proxy/issues/70)
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/opencode-claude-max-proxy/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/opencode-claude-max-proxy/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* npm publish with automation token ([230b185](https://github.com/rynfar/opencode-claude-max-proxy/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/opencode-claude-max-proxy/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/opencode-claude-max-proxy/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/opencode-claude-max-proxy/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/opencode-claude-max-proxy/issues/49)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/opencode-claude-max-proxy/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/opencode-claude-max-proxy/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/opencode-claude-max-proxy/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/opencode-claude-max-proxy/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/opencode-claude-max-proxy/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/opencode-claude-max-proxy/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/opencode-claude-max-proxy/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/opencode-claude-max-proxy/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/opencode-claude-max-proxy/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/opencode-claude-max-proxy/issues/18)
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/opencode-claude-max-proxy/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/opencode-claude-max-proxy/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/opencode-claude-max-proxy/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/opencode-claude-max-proxy/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/opencode-claude-max-proxy/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/opencode-claude-max-proxy/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/opencode-claude-max-proxy/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/opencode-claude-max-proxy/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/opencode-claude-max-proxy/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/opencode-claude-max-proxy/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/opencode-claude-max-proxy/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/opencode-claude-max-proxy/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/opencode-claude-max-proxy/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/opencode-claude-max-proxy/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/opencode-claude-max-proxy/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/opencode-claude-max-proxy/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/opencode-claude-max-proxy/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/opencode-claude-max-proxy/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/opencode-claude-max-proxy/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/opencode-claude-max-proxy/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/opencode-claude-max-proxy/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/opencode-claude-max-proxy/issues/16)
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/opencode-claude-max-proxy/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/opencode-claude-max-proxy/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/opencode-claude-max-proxy/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)
* trigger npm publish with token ([c603363](https://github.com/rynfar/opencode-claude-max-proxy/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/opencode-claude-max-proxy/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.15.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.2...v1.15.3) (2026-03-24)


### Bug Fixes

* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/opencode-claude-max-proxy/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)

## [1.15.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.1...v1.15.2) (2026-03-24)


### Bug Fixes

* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/opencode-claude-max-proxy/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/opencode-claude-max-proxy/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)

## [1.15.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.0...v1.15.1) (2026-03-23)


### Bug Fixes

* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/opencode-claude-max-proxy/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/opencode-claude-max-proxy/commit/46be89aae0be674d94111b2b9bb597363ec25463))

## [1.15.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.14.0...v1.15.0) (2026-03-23)


### Features

* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/opencode-claude-max-proxy/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/opencode-claude-max-proxy/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/opencode-claude-max-proxy/issues/104)


### Bug Fixes

* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/opencode-claude-max-proxy/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/opencode-claude-max-proxy/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/opencode-claude-max-proxy/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/opencode-claude-max-proxy/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))

## [1.14.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.6...v1.14.0) (2026-03-23)


### Features

* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))


### Bug Fixes

* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/opencode-claude-max-proxy/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/opencode-claude-max-proxy/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))

## [1.13.6](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.5...v1.13.6) (2026-03-23)


### Bug Fixes

* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/opencode-claude-max-proxy/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/opencode-claude-max-proxy/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/opencode-claude-max-proxy/issues/99)

## [1.13.5](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.4...v1.13.5) (2026-03-23)


### Bug Fixes

* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))

## [1.13.4](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.3...v1.13.4) (2026-03-23)


### Bug Fixes

* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/opencode-claude-max-proxy/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/opencode-claude-max-proxy/commit/617530daa216daa916d72c5a612c8ee574ceff74))

## [1.13.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.2...v1.13.3) (2026-03-23)


### Bug Fixes

* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/opencode-claude-max-proxy/commit/93ef05030825f2668e49063d5991e188af483f5f))

## [1.13.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.1...v1.13.2) (2026-03-23)


### Bug Fixes

* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/opencode-claude-max-proxy/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))

## [1.13.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.0...v1.13.1) (2026-03-23)


### Bug Fixes

* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/opencode-claude-max-proxy/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/opencode-claude-max-proxy/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/opencode-claude-max-proxy/issues/86)

## [1.13.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.12.2...v1.13.0) (2026-03-22)


### Features

* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/opencode-claude-max-proxy/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/opencode-claude-max-proxy/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/opencode-claude-max-proxy/issues/81)

## [1.12.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.12.1...v1.12.2) (2026-03-22)


### Bug Fixes

* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/opencode-claude-max-proxy/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/opencode-claude-max-proxy/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/opencode-claude-max-proxy/issues/74)
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/opencode-claude-max-proxy/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/opencode-claude-max-proxy/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/opencode-claude-max-proxy/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/opencode-claude-max-proxy/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/opencode-claude-max-proxy/commit/10c9a3c047978fe2e98d291254919bd992461218))

## [1.12.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.12.0...v1.12.1) (2026-03-21)


### Bug Fixes

* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/opencode-claude-max-proxy/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/opencode-claude-max-proxy/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/opencode-claude-max-proxy/issues/69)
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/opencode-claude-max-proxy/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/opencode-claude-max-proxy/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/opencode-claude-max-proxy/issues/70)

## [1.12.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.11.2...v1.12.0) (2026-03-21)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/opencode-claude-max-proxy/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))


### Bug Fixes

* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/opencode-claude-max-proxy/commit/7270b47451c0a6859ab815df1df0b1def4583842))

## [1.11.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.11.1...v1.11.2) (2026-03-20)


### Bug Fixes

* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/opencode-claude-max-proxy/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/opencode-claude-max-proxy/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/opencode-claude-max-proxy/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/opencode-claude-max-proxy/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/opencode-claude-max-proxy/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))

## [1.11.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.11.0...v1.11.1) (2026-03-20)


### Bug Fixes

* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/opencode-claude-max-proxy/commit/1698713c0206716647e51392f056cb1aabb05f74))

## [1.11.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.10.1...v1.11.0) (2026-03-20)


### Features

* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/opencode-claude-max-proxy/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/opencode-claude-max-proxy/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))


### Bug Fixes

* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/opencode-claude-max-proxy/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/opencode-claude-max-proxy/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/opencode-claude-max-proxy/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))

## [1.10.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.10.0...v1.10.1) (2026-03-20)


### Bug Fixes

* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/opencode-claude-max-proxy/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/opencode-claude-max-proxy/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/opencode-claude-max-proxy/issues/49)

## [1.10.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.9.0...v1.10.0) (2026-03-20)


### Features

* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/opencode-claude-max-proxy/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/opencode-claude-max-proxy/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/opencode-claude-max-proxy/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/opencode-claude-max-proxy/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/opencode-claude-max-proxy/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/opencode-claude-max-proxy/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/opencode-claude-max-proxy/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/opencode-claude-max-proxy/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/opencode-claude-max-proxy/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/opencode-claude-max-proxy/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/opencode-claude-max-proxy/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/opencode-claude-max-proxy/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/opencode-claude-max-proxy/issues/21)
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/opencode-claude-max-proxy/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/opencode-claude-max-proxy/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/opencode-claude-max-proxy/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/opencode-claude-max-proxy/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/opencode-claude-max-proxy/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/opencode-claude-max-proxy/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/opencode-claude-max-proxy/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/opencode-claude-max-proxy/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/opencode-claude-max-proxy/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/opencode-claude-max-proxy/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/opencode-claude-max-proxy/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/opencode-claude-max-proxy/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/opencode-claude-max-proxy/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/opencode-claude-max-proxy/commit/18a02805680c29c96dd53788601577c78c709b33))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/opencode-claude-max-proxy/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/opencode-claude-max-proxy/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* npm publish with automation token ([230b185](https://github.com/rynfar/opencode-claude-max-proxy/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/opencode-claude-max-proxy/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/opencode-claude-max-proxy/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/opencode-claude-max-proxy/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/opencode-claude-max-proxy/issues/18)
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/opencode-claude-max-proxy/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/opencode-claude-max-proxy/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/opencode-claude-max-proxy/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/opencode-claude-max-proxy/issues/16)
* trigger npm publish with token ([c603363](https://github.com/rynfar/opencode-claude-max-proxy/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.9.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.8.1...v1.9.0) (2026-03-20)


### Features

* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/opencode-claude-max-proxy/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/opencode-claude-max-proxy/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))

## [1.8.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.8.0...v1.8.1) (2026-03-20)


### Bug Fixes

* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/opencode-claude-max-proxy/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)

## [1.8.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.3...v1.8.0) (2026-03-20)


### Features

* Docker support and README install options ([cfb8396](https://github.com/rynfar/opencode-claude-max-proxy/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/opencode-claude-max-proxy/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)


### Bug Fixes

* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/opencode-claude-max-proxy/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))

## [1.7.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.2...v1.7.3) (2026-03-20)


### Bug Fixes

* npm publish with automation token ([230b185](https://github.com/rynfar/opencode-claude-max-proxy/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))

## [1.7.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.1...v1.7.2) (2026-03-20)


### Bug Fixes

* trigger npm publish with token ([c603363](https://github.com/rynfar/opencode-claude-max-proxy/commit/c60336316102e440c22164eb5656a8142cea4cf0))

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
