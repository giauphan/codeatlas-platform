-- Database structure for Tiered Memory Architecture (Oracle 26ai)
-- Supports SaaS Multi-Tenant Security using Oracle Virtual Private Database (VPD)

-- 1. Episodic Memory Tier (Stores events, JSON Relational Duality)
CREATE TABLE ai_episodic_memory (
    id VARCHAR2(255) PRIMARY KEY,
    project_name VARCHAR2(255) NOT NULL,
    event_type VARCHAR2(50) NOT NULL,
    event_data JSON, -- Oracle Native JSON datatype
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL -- Client ID (uid from Firebase Auth)
);

CREATE INDEX idx_episodic_tenant_proj ON ai_episodic_memory(tenant_id, project_name);

-- 2. Semantic Memory Tier (Stores logical events and code entities)
-- Contains Vector Embeddings for AI Vector Search RAG
CREATE TABLE ai_semantic_memory (
    id VARCHAR2(255) PRIMARY KEY,
    project_name VARCHAR2(255) NOT NULL,
    entity_type VARCHAR2(50),
    entity_name VARCHAR2(255),
    file_path VARCHAR2(1000),
    content CLOB,
    embedding VECTOR(4096, FLOAT32), -- 4096-dimensional Vector, FLOAT32 (NVIDIA nv-embed-v1)
    tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL
);

CREATE INDEX idx_semantic_tenant_proj ON ai_semantic_memory(tenant_id, project_name);

-- 3. Relational / Knowledge Graph Tier (Temporal Property Graph)
CREATE TABLE ai_relational_memory (
    source_id VARCHAR2(255),
    target_id VARCHAR2(255),
    project_name VARCHAR2(255),
    relationship_type VARCHAR2(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP, -- For Temporal Graph model (Zep)
    tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL,
    PRIMARY KEY(source_id, target_id, relationship_type, tenant_id)
);

-- Optional: Enable Property Graph for Oracle 23ai/26ai
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
-- ORACLE VIRTUAL PRIVATE DATABASE (VPD) CONFIGURATION FOR SAAS MULTI-TENANCY
--------------------------------------------------------------------------------

-- Step 1: Initialize Security Context to store tenant_id for the current connection session
-- CREATE OR REPLACE CONTEXT codeatlas_ctx USING ADMIN.codeatlas_ctx_pkg;

-- Step 2: Create Package to set tenant_id context
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

-- Step 3: Create Policy Function returning the SQL predicate for row-level filtering
/*
CREATE OR REPLACE FUNCTION get_tenant_predicate(
    p_schema IN VARCHAR2,
    p_table  IN VARCHAR2
) RETURN VARCHAR2 IS
    v_tenant_id VARCHAR2(255);
BEGIN
    -- Get tenant_id of the current session
    v_tenant_id := SYS_CONTEXT('codeatlas_ctx', 'tenant_id');
    
    -- If context is not set, default to block access for maximum security
    IF v_tenant_id IS NULL THEN
        RETURN '1=0';
    ELSE
        -- Automatically append row-filtering condition: tenant_id = 'USER_UID'
        RETURN 'tenant_id = ''' || v_tenant_id || '''';
    END IF;
END;
/
*/

-- Step 4: Register Security Policy for the 3 main tables
/*
BEGIN
    -- 1. Episodic Memory Table
    DBMS_RLS.ADD_POLICY(
        object_schema   => 'ADMIN',
        object_name     => 'ai_episodic_memory',
        policy_name     => 'episodic_tenant_policy',
        function_schema => 'ADMIN',
        policy_function => 'get_tenant_predicate',
        statement_types => 'SELECT,INSERT,UPDATE,DELETE',
        update_check    => TRUE
    );
    
    -- 2. Semantic Memory Table
    DBMS_RLS.ADD_POLICY(
        object_schema   => 'ADMIN',
        object_name     => 'ai_semantic_memory',
        policy_name     => 'semantic_tenant_policy',
        function_schema => 'ADMIN',
        policy_function => 'get_tenant_predicate',
        statement_types => 'SELECT,INSERT,UPDATE,DELETE',
        update_check    => TRUE
    );
    
    -- 3. Relational Memory Table
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
