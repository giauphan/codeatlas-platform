import urllib.request
import json
import subprocess

diff = subprocess.check_output(['git', 'diff', '--staged']).decode('utf-8')

req = urllib.request.Request(
    "http://localhost:8000/review",
    data=json.dumps({"diff": diff}).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req) as response:
        print(response.read().decode("utf-8"))
except Exception as e:
    print(f"Error: {e}")
