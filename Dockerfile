FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1
ENV HOST=0.0.0.0
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY python/mars_datasets/scripts/requirements-hosted-route.txt /tmp/requirements-hosted-route.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/requirements-hosted-route.txt

COPY . .
EXPOSE 5000
CMD ["npm", "start"]
