# Security testing: what runs where

This note records where each kind of security test is allowed to run.

## On the development laptop (allowed)

The automated regression suite in `web/security-tests/` runs on a development laptop with `cd web && npm run test:security`. Every server it starts listens on 127.0.0.1 only, every request it makes goes to 127.0.0.1, and no vendor is contacted: the API keys are removed from the server's environment and the Piper fallback is replaced by a spy script. The suite also checks that the app refuses a connection on the laptop's LAN address, which only needs a connection attempt and never opens a listener there. It takes about a minute, because Next.js compiles each route once.

## On an isolated machine only (not part of the suite)

Anything that opens a listener on a real network interface belongs on an isolated test machine on an isolated network, for example a spare laptop on a travel router with no other devices. That covers live penetration testing from a second device (a phone that may be compromised, ARP spoofing, rogue access points, TLS stripping) and any test of the recognizer server's LAN mode. The reason is simple: an attack test that exposes the app on a laptop's Wi-Fi interface also exposes it to every other device on that network, including the hotel or campus network the laptop happens to be on.

## Physical fallback

If the app or the network fails during a real check-in, the desk keeps a printed card that says "Please wave or knock for attention" and offers pen and paper. This fallback needs no device and cannot be attacked over the network.
