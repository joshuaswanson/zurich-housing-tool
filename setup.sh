#!/bin/bash
# zurich-housing-tool setup
# Run once after cloning: ./setup.sh

set -e

echo ""
echo "  zurich-housing-tool setup"
echo "  ========================="
echo ""

# 1. Install Node dependencies
echo "  [1/5] Installing dependencies..."
npm install --silent 2>/dev/null
echo "        done."

# 2. Copy config if not exists
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "  [2/5] Created config.json (edit target location if needed)"
else
  echo "  [2/5] config.json already exists, skipping."
fi

# 3. Copy profile if not exists
if [ ! -f profile.json ]; then
  cp profile.example.json profile.json
  echo "  [3/5] Created profile.json (fill in your details for LLM message generation)"
else
  echo "  [3/5] profile.json already exists, skipping."
fi

# 4. Check for Ollama
if command -v ollama &> /dev/null; then
  echo "  [4/5] Ollama found."
  if ! ollama list 2>/dev/null | grep -q "llama3.2"; then
    echo "        Pulling llama3.2 model (~2GB)..."
    ollama pull llama3.2
  else
    echo "        llama3.2 model already available."
  fi
else
  echo "  [4/5] Ollama not found. Install from https://ollama.com for LLM message generation."
  echo "        (The tool works without it, you just won't have auto-generated messages.)"
fi

# 5. Initial scan
echo "  [5/5] Running initial scan (this takes ~90 seconds on first run)..."
node monitor.js scan --fresh > /dev/null 2>&1 || true

echo ""
echo "  Setup complete. Run the dashboard with:"
echo ""
echo "    node server.js"
echo ""
echo "  Then open http://localhost:3456"
echo ""
