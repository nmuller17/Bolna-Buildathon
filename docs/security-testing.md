# Security testing: what runs where

This note records where each kind of security test is allowed to run. It was written on 2026-10-10, when the web app was being built on Talha's laptop.

## On the development laptop (allowed)

The automated regression suite in `web/security-tests/` runs on the development laptop with `cd web && npm run test:security`. Every server it starts listens on 127.0.0.1 only, every request it makes goes to 127.0.0.1, and no vendor is contacted (the API keys are removed from the server's environment and Piper is replaced by a spy script). The suite also checks that the default server refuses a connection on the laptop's LAN address, which only needs a connection attempt and never opens a listener there.

## On an isolated machine only (deferred)

Anything that opens a listener on a real network interface is deferred to an isolated test machine on an isolated network (for example a spare laptop on a travel router with no other devices). This covers three things:

1. The `server.mjs --lan` block of `web/security-tests/server.test.mjs`, which starts the app on the LAN address and attacks it from that address. It is skipped unless the environment variable `SB_SECTEST_LAN=1` is set, and it should only be set on the isolated machine.
2. Live LAN and penetration testing by the expert testers, including attacks from a second device, a phone that may be compromised, and network-level attacks (ARP spoofing, rogue access points, TLS stripping).
3. Any test of the recognizer's LAN mode.

The reason is simple: an attack test that exposes the app on this Mac's Wi-Fi interface also exposes it to every other device on that network, including the hotel or campus network the laptop happens to be on.

## Physical fallback

If the app or the network fails during a real check-in, the desk keeps a printed card that says "Please wave or knock for attention" and offers pen and paper. This fallback needs no device and cannot be attacked over the network.
