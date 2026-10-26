FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /bridge
COPY deploy/partnerium/codex/codex-client.mjs deploy/partnerium/codex/server.mjs ./
RUN mkdir /work && chown node:node /work
USER node
ENV CODEX_HOME=/auth HOME=/tmp
CMD ["node", "server.mjs"]
