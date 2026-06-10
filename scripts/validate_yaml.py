import sys
import yaml

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/acb/app/infra/litellm/config.live.yaml"
with open(path, encoding="utf-8") as f:
    data = yaml.safe_load(f)
models = [m["model_name"] for m in data.get("model_list", [])]
print("YAML OK -", len(models), "models")
for m in models:
    print("  -", m)
