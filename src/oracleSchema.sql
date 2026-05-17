-- Cấu trúc Database cho Tiered Memory Architecture (Oracle 26ai)
-- Hỗ trợ Bảo mật SaaS Multi-Tenant bằng Oracle Virtual Private Database (VPD)

-- 1. Tầng Episodic Memory (Lưu sự kiện, JSON Relational Duality)
CREATE TABLE ai_episodic_memory (
    id VARCHAR2(255) PRIMARY KEY,
    project_name VARCHAR2(255) NOT NULL,
    event_type VARCHAR2(50) NOT NULL,
    event_data JSON, -- Oracle Native JSON datatype
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL -- ID khách hàng (uid từ Firebase Auth)
);

CREATE INDEX idx_episodic_tenant_proj ON ai_episodic_memory(tenant_id, project_name);

-- 2. Tầng Semantic Memory (Kho sự kiện logic)
-- Chứa Vector Embedding để dùng AI Vector Search RAG
CREATE TABLE ai_semantic_memory (
    id VARCHAR2(255) PRIMARY KEY,
    project_name VARCHAR2(255) NOT NULL,
    entity_type VARCHAR2(50),
    entity_name VARCHAR2(255),
    file_path VARCHAR2(1000),
    content CLOB,
    embedding VECTOR(1536, FLOAT32), -- Vector 1536 chiều, FLOAT32 (OpenAI hoặc tương tự)
    tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL
);

CREATE INDEX idx_semantic_tenant_proj ON ai_semantic_memory(tenant_id, project_name);

-- 3. Tầng Relational / Knowledge Graph (Temporal Property Graph)
CREATE TABLE ai_relational_memory (
    source_id VARCHAR2(255),
    target_id VARCHAR2(255),
    project_name VARCHAR2(255),
    relationship_type VARCHAR2(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP, -- Phục vụ mô hình Temporal (Zep)
    tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL,
    PRIMARY KEY(source_id, target_id, relationship_type, tenant_id)
);

-- Tuỳ chọn: Kích hoạt Property Graph cho Oracle 23ai/26ai
CREATE PROPERTY GRAPH ai_knowledge_graph
    VERTEX TABLES (
        ai_semantic_memory KEY(id)
        PROPERTIES (project_name, entity_type, entity_name, file_path, tenant_id)
    )
    EDGE TABLES (
        ai_relational_memory KEY(source_id, target_id, relationship_type, tenant_id)
        SOURCE KEY(source_id) REFERENCES ai_semantic_memory(id)
        DESTINATION KEY(target_id) REFERENCES ai_semantic_memory(id)
        PROPERTIES (relationship_type, created_at, expires_at, tenant_id)
    );

--------------------------------------------------------------------------------
-- CẤU HÌNH ORACLE VIRTUAL PRIVATE DATABASE (VPD) CHO SAAS MULTI-TENANCY
--------------------------------------------------------------------------------

-- Bước 1: Khởi tạo Security Context để lưu trữ tenant_id cho connection session hiện tại
-- CREATE OR REPLACE CONTEXT codeatlas_ctx USING ADMIN.codeatlas_ctx_pkg;

-- Bước 2: Tạo Package gán context tenant_id
/*
CREATE OR REPLACE PACKAGE codeatlas_ctx_pkg IS
    PROCEDURE set_tenant(p_tenant_id IN VARCHAR2);
END;
/

CREATE OR REPLACE PACKAGE BODY codeatlas_ctx_pkg IS
    PROCEDURE set_tenant(p_tenant_id IN VARCHAR2) IS
    BEGIN
        DBMS_SESSION.SET_CONTEXT('codeatlas_ctx', 'tenant_id', p_tenant_id);
    END;
END;
/
*/

-- Bước 3: Tạo Policy Function trả về SQL predicate lọc dữ liệu
/*
CREATE OR REPLACE FUNCTION get_tenant_predicate(
    p_schema IN VARCHAR2,
    p_table  IN VARCHAR2
) RETURN VARCHAR2 IS
    v_tenant_id VARCHAR2(255);
BEGIN
    -- Lấy tenant_id của session hiện tại
    v_tenant_id := SYS_CONTEXT('codeatlas_ctx', 'tenant_id');
    
    -- Nếu chưa thiết lập Context, mặc định chặn truy cập để an toàn tuyệt đối
    IF v_tenant_id IS NULL THEN
        RETURN '1=0';
    ELSE
        -- Tự động chèn điều kiện lọc ngầm: tenant_id = 'USER_UID'
        RETURN 'tenant_id = ''' || v_tenant_id || '''';
    END IF;
END;
/
*/

-- Bước 4: Đăng ký Security Policy cho 3 bảng dữ liệu chính
/*
BEGIN
    -- 1. Bảng Episodic Memory
    DBMS_RLS.ADD_POLICY(
        object_schema   => 'ADMIN',
        object_name     => 'ai_episodic_memory',
        policy_name     => 'episodic_tenant_policy',
        function_schema => 'ADMIN',
        policy_function => 'get_tenant_predicate',
        statement_types => 'SELECT,INSERT,UPDATE,DELETE',
        update_check    => TRUE
    );
    
    -- 2. Bảng Semantic Memory
    DBMS_RLS.ADD_POLICY(
        object_schema   => 'ADMIN',
        object_name     => 'ai_semantic_memory',
        policy_name     => 'semantic_tenant_policy',
        function_schema => 'ADMIN',
        policy_function => 'get_tenant_predicate',
        statement_types => 'SELECT,INSERT,UPDATE,DELETE',
        update_check    => TRUE
    );
    
    -- 3. Bảng Relational Memory
    DBMS_RLS.ADD_POLICY(
        object_schema   => 'ADMIN',
        object_name     => 'ai_relational_memory',
        policy_name     => 'relational_tenant_policy',
        function_schema => 'ADMIN',
        policy_function => 'get_tenant_predicate',
        statement_types => 'SELECT,INSERT,UPDATE,DELETE',
        update_check    => TRUE
    );
END;
/
*/
