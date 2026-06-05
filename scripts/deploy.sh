#!/bin/bash

# Target paths on VPS
PROJECTS_ROOT="/var/www/codeatlas-ai"
TENANTS_DIR="$PROJECTS_ROOT/tenants"

echo "=========================================================="
echo "⚡ CodeAtlas Enterprise: Auto-Assign Projects to User 1 ⚡"
echo "=========================================================="

# 1. Check if tenants directory exists
if [ ! -d "$TENANTS_DIR" ]; then
  echo "❌ Error: Tenants directory not found at $TENANTS_DIR."
  echo "Please make sure you are running this on the VPS."
  exit 1
fi

# 2. Find tenant directories (Firebase UIDs)
TENANTS=($(find "$TENANTS_DIR" -maxdepth 1 -mindepth 1 -type d -printf '%f\n'))

if [ ${#TENANTS[@]} -eq 0 ]; then
  echo "⚠️  No active user tenant folders found in $TENANTS_DIR."
  echo "💡 Tip: Please log in to the CodeAtlas UI at least once using User 1's account."
  echo "This will automatically create their tenant directory under tenants/."
  exit 1
fi

# Select the first tenant as User 1
USER_UID="${TENANTS[0]}"
USER_DIR="$TENANTS_DIR/$USER_UID"

echo "👤 Detected User 1 Tenant UID: $USER_UID"
echo "📂 User Tenant Directory: $USER_DIR"
echo ""

# 3. Find other projects on the VPS
# We will search in /var/www and /home/ubuntu for other directories that look like projects
echo "🔍 Searching for other projects on the VPS..."
POTENTIAL_PROJECTS=()

# Search /var/www/
for d in /var/www/*; do
  if [ -d "$d" ] && [ "$d" != "$PROJECTS_ROOT" ] && [ "$d" != "/var/www/html" ]; then
    POTENTIAL_PROJECTS+=("$d")
  fi
done

# Search /home/ubuntu/
for d in /home/ubuntu/*; do
  if [ -d "$d" ] && [[ ! "$(basename "$d")" =~ ^(\..*|snap|instantclient)$ ]]; then
    POTENTIAL_PROJECTS+=("$d")
  fi
done

if [ ${#POTENTIAL_PROJECTS[@]} -eq 0 ]; then
  echo "⚠️  No other project directories found in /var/www/ or /home/ubuntu/."
  echo "💡 If you have projects elsewhere, you can link them manually:"
  echo "ln -s /path/to/your/project $USER_DIR/"
  exit 0
fi

echo "📦 Found ${#POTENTIAL_PROJECTS[@]} potential project(s):"
for p in "${POTENTIAL_PROJECTS[@]}"; do
  echo "  - $p"
done
echo ""

# 4. Link projects to the user directory
for src in "${POTENTIAL_PROJECTS[@]}"; do
  name=$(basename "$src")
  dest="$USER_DIR/$name"
  
  if [ -e "$dest" ]; then
    echo "ℹ️  $name already exists in User 1's workspace. Skipping."
  else
    echo "🔗 Linking $name -> $dest..."
    ln -s "$src" "$dest"
    echo "✅ Successfully linked $name!"
  fi
done

echo ""
echo "🎉 All done! Please refresh your CodeAtlas Dashboard to see all projects under User 1's account!"
echo "=========================================================="
