# Stored-message fixtures

Real `UIMessage.parts` captured by running `streamText` + `readUIMessageStream` under `ai@5.0.228`
and `ai@6.0.246`, not hand-authored from changelogs. They are the evidence behind the
compatibility claim in `test/compat.test.ts`: the parts this package stores are accepted
unchanged by the current SDK.

Re-capture by installing the target major in a scratch project and streaming each shape through
its own `readUIMessageStream`, then saving `message.parts`.
