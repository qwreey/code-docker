# Small, single-purpose image - see fix.sh's own header comment and
# docs/egress-netgate.md's "Docker의 DOCKER-INTERNAL 강제 격리" section for why this
# exists. Deliberately its own minimal image (not layered onto code-docker or router)
# so the network_mode: host + NET_ADMIN + docker.sock trust tier this needs stays scoped
# to one tiny container instead of expanding an existing one's blast radius.
FROM alpine:3.20

RUN apk add --no-cache nftables curl jq iproute2

COPY fix.sh /fix.sh
RUN chmod +x /fix.sh

ENTRYPOINT ["/fix.sh"]
