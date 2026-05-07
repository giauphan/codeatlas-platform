import oracledb
import os
from dotenv import load_dotenv

load_dotenv()

def test_tls():
    print("🚀 Testing codeatlasdatabase via PYTHON (TLS - NO WALLET)...")
    
    user = os.getenv("ORACLE_USER", "ADMIN")
    password = os.getenv("ORACLE_PASSWORD")
    
    # Exact LOW string
    dsn = "(description= (retry_count=20)(retry_delay=3)(address=(protocol=tcps)(port=1522)(host=adb.ap-singapore-1.oraclecloud.com))(connect_data=(service_name=gba4ef248f7791d_codeatlasdatabase_low.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))"

    try:
        conn = oracledb.connect(
            user=user,
            password=password,
            dsn=dsn
        )
        print("✅ SUCCESS! Python connected via TLS!")
        conn.close()
    except Exception as e:
        print(f"❌ Python failed: {e}")

if __name__ == "__main__":
    test_tls()
