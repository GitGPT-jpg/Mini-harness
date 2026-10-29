-- 需求表
CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    author TEXT DEFAULT '匿名用户',
    votes_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open', -- open, planned, in_progress, completed, closed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 投票记录表（防重复刷票 + 支持取消投票）
CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(feature_id, voter_id),
    FOREIGN KEY(feature_id) REFERENCES features(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_features_status_votes ON features(status, votes_count DESC);
CREATE INDEX IF NOT EXISTS idx_votes_feature_voter ON votes(feature_id, voter_id);
