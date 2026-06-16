#!/bin/bash

# Create layer directory structure
mkdir -p /tmp/dcv-layer/python

# Download DCV Session Manager CLI
cd /tmp/dcv-layer
wget https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-session-manager-cli.zip
unzip nice-dcv-session-manager-cli.zip

# Move dcvsm to python directory (Lambda layer structure)
mv dcvsm python/
chmod +x python/dcvsm

# Create zip for Lambda layer
zip -r dcv-session-manager-layer.zip python/

echo "Layer created: /tmp/dcv-layer/dcv-session-manager-layer.zip"
