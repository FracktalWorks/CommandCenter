#!/usr/bin/env bash
set -e
# Kill any existing LiteLLM
pkill -f litellm 2>/dev/null || true
sleep 2

# Write config
cat > /tmp/llm.yaml << 'EOF'
model_list:
- model_name: deepseek/deepseek-chat
  litellm_params:
    model: deepseek/deepseek-chat
    api_key: os.environ/DEEPSEEK_API_KEY
- model_name: deepseek/deepseek-reasoner
  litellm_params:
    model: deepseek/deepseek-reasoner
    api_key: os.environ/DEEPSEEK_API_KEY
- model_name: gemini/gemini-2.5-flash
  litellm_params:
    model: gemini/gemini-2.5-flash
    api_key: os.environ/GEMINI_API_KEY
- model_name: groq/llama-3.3-70b
  litellm_params:
    model: groq/llama-3.3-70b-versatile
    api_key: os.environ/GROQ_API_KEY
- model_name: openrouter/deepseek/deepseek-v4-pro
  litellm_params:
    model: openrouter/deepseek/deepseek-v4-pro
    api_key: os.environ/OPENROUTER_API_KEY
- model_name: openrouter/deepseek/deepseek-v4-flash
  litellm_params:
    model: openrouter/deepseek/deepseek-v4-flash
    api_key: os.environ/OPENROUTER_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: "postgresql://none:none@localhost/none"

litellm_settings:
  drop_params: true
EOF

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd /opt/acb/app
source .env

echo "Starting LiteLLM..."
nohup uv run litellm --config /tmp/llm.yaml --port 4000 > /tmp/llm.log 2>&1 &
PID=$!
echo "PID=$PID"

# Wait for startup
for i in $(seq 1 20); do
  if curl -sf http://localhost:4000/health > /dev/null 2>&1; then
    echo "LiteLLM is UP! (PID=$PID)"
    curl -s http://localhost:4000/health
    exit 0
  fi
  sleep 3
done

echo "FAILED after 60s. Log:"
tail -30 /tmp/llm.log
exit 1
