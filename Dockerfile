# --- Étape 1 : tests de round-trip (le build échoue si un test casse) ---
FROM node:22-alpine AS test
WORKDIR /app
COPY marshal-reader.js marshal-writer.js ./
COPY tests ./tests
RUN node tests/run-node.js

# --- Étape 2 : serveur statique (nginx non-root, écoute sur 8080) ---
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=test /app/marshal-reader.js /app/marshal-writer.js /usr/share/nginx/html/
COPY index.html style.css tree-view.js search.js diff.js app.js tests.html /usr/share/nginx/html/
COPY tests/fixtures.js tests/test-suite.js /usr/share/nginx/html/tests/
COPY samples /usr/share/nginx/html/samples
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
