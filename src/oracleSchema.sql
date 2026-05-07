-- Cấu trúc Database cho Tiered Memory Architecture (Oracle 26ai)

-- 1. Tầng Episodic Memory (Lưu sự kiện, JSON Relational Duality)
CREATE TABLE ai_episodic_memory (
    id VARCHAR2(255) PRIMARY KEY,
    project_name VARCHAR2(255) NOT NULL,
    event_type VARCHAR2(50) NOT NULL,
    event_data JSON, -- Oracle Native JSON datatype
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_episodic_project ON ai_episodic_memory(project_name);

-- 2. Tầng Semantic Memory (Kho sự kiện logic)
-- Chứa Vector Embedding để dùng AI Vector Search RAG
CREATE TABLE ai_semantic_memory (
    id VARCHAR2(255) PRIMARY KEY,
    project_name VARCHAR2(255) NOT NULL,
    entity_type VARCHAR2(50),
    entity_name VARCHAR2(255),
    file_path VARCHAR2(1000),
    content CLOB,
    -- Giả sử sử dụng Vector 1536 chiều, FLOAT32 (OpenAI hoặc tương tự)
    embedding VECTOR(1536, FLOAT32) 
);

CREATE INDEX idx_semantic_project ON ai_semantic_memory(project_name);

-- 3. Tầng Relational / Knowledge Graph (Temporal Property Graph)
CREATE TABLE ai_relational_memory (
    source_id VARCHAR2(255),
    target_id VARCHAR2(255),
    project_name VARCHAR2(255),
    relationship_type VARCHAR2(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP, -- Phục vụ mô hình Temporal (Zep)
    PRIMARY KEY(source_id, target_id, relationship_type)
);

-- Tuỳ chọn: Kích hoạt Property Graph cho Oracle 23ai/26ai
CREATE PROPERTY GRAPH ai_knowledge_graph
    VERTEX TABLES (
        ai_semantic_memory KEY(id)
        PROPERTIES (project_name, entity_type, entity_name, file_path)
    )
    EDGE TABLES (
        ai_relational_memory KEY(source_id, target_id, relationship_type)
        SOURCE KEY(source_id) REFERENCES ai_semantic_memory(id)
        DESTINATION KEY(target_id) REFERENCES ai_semantic_memory(id)
        PROPERTIES (relationship_type, created_at, expires_at)
    );
