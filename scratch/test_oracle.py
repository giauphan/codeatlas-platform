import oracledb
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

def test_connection():
    print("🚀 Testing codeatlasdatabase via PYTHON...")
    
    user = os.getenv("ORACLE_USER", "ADMIN")
    password = os.getenv("ORACLE_PASSWORD")
    wallet_path = str(Path.cwd() / "wallet")
    
    print(f"Using User: {user}")
    print(f"Wallet Path: {wallet_path}")

    try:
        # Connect in thin mode
        conn = oracledb.connect(
            user=user,
            password=password,
            dsn="codeatlasdatabase_low",
            config_dir=wallet_path,
            wallet_location=wallet_path,
            wallet_password=password
        )
        print("✅ SUCCESS! Python connected to codeatlasdatabase!")
        cursor = conn.cursor()
        cursor.execute("SELECT sysdate FROM dual")
        print(f"Result: {cursor.fetchone()[0]}")
        conn.close()
    except Exception as e:
        print(f"❌ Python also failed: {e}")

if __name__ == "__main__":
    test_connection()
