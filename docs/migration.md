# Harness import and Desktop coexistence

The web adapter vendors pure routing, retrieval, context-budget and authority code
from the commit recorded in vendor/UPSTREAM.md. Organization documents and
registries are deliberately absent from this public repository.

The operator exporter reads a trusted, authorized checkout and the upstream
registered-document catalog. Restricted, unavailable and retired sources are
excluded; canonical path checks prevent reading outside that checkout. It exports
Skill instructions/mandatory-reference IDs and authority/organization registries.
Output is bounded and scanned for recognizable credentials, created exclusively
with private filesystem modes. Only ignored `.exports/` may hold packs locally.

The importer validates the pack then atomically replaces one tenant's sources and
Skills through a service-only RPC. Active jobs block import; invalid rows roll
back. Provenance stays attached. Re-importing a reviewed earlier pack rolls back
source changes without rolling back employee data.

`harness:verify` reads the upstream corpus locally and prints counts only. All
61 original retrieval/abstention questions plus three buyer-identity questions
must pass before changing the recorded upstream commit. This measures retrieval,
not generated-answer accuracy. Public tests use synthetic documents only.

Desktop stays available for native tools and older workflows. The web API offers
named actions, not arbitrary IPC, filesystem, SQL, shell or browser execution.
There is no silent bulk upload of old memory/history. Pilot staff copy selected
durable preferences into their confirmed memory, upload selected files or choose
Drive references. A future personal-data importer needs authenticated ownership
mapping, preview and idempotency; secrets and transient job logs are excluded.
