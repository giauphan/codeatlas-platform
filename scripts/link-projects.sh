#!/bin/bash

# Check if tenant ID is provided
if [ -z "$1" ]; then
  echo "❌ Error: Please provide a Tenant ID (Firebase User UID)."
  echo "Usage: ./link_projects.sh <tenant_id> [project_name_1] [project_name_2] ..."
  echo "Example: ./link_projects.sh tenant_user_1 shopee-deal-sweeper gemini-openai-proxy"
  exit 1
fi

TENANT_ID=$1
shift

# Root paths
TENANTS_ROOT="/home/biibon/CodeAtlas/tenants"
USER_DIR="$TENANTS_ROOT/$TENANT_ID"

echo "⚙️ Creating tenant directory at: $USER_DIR"
mkdir -p "$USER_DIR"

# If no specific projects are provided, list available ones and exit
if [ $# -eq 0 ]; then
  echo "💡 No specific projects provided. Here are the available projects in /home/biibon/:"
  find /home/biibon/ -maxdepth 1 -type d -not -path '*/.*' -not -path '/home/biibon/' | sed 's|/home/biibon/||'
  echo ""
  echo "To link a project, run:"
  echo "./link_projects.sh $TENANT_ID <project_name>"
  exit 0
fi

# Link each specified project
for PROJECT_NAME in "$@"; do
  SRC_PATH="/home/biibon/$PROJECT_NAME"
  DEST_PATH="$USER_DIR/$PROJECT_NAME"
  
  if [ ! -d "$SRC_PATH" ]; then
    echo "❌ Error: Project directory not found at $SRC_PATH"
    continue
  fi
  
  if [ -e "$DEST_PATH" ]; then
    echo "ℹ️ Project $PROJECT_NAME is already linked or exists in $USER_DIR. Skipping."
  else
    echo "🔗 Linking $PROJECT_NAME -> $DEST_PATH..."
    ln -s "$SRC_PATH" "$DEST_PATH"
    echo "✅ Successfully linked $PROJECT_NAME!"
  fi
done

echo "🎉 Done! F5 or refresh your dashboard to see the changes."
