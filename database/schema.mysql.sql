CREATE DATABASE IF NOT EXISTS quiz_checker
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE quiz_checker;

CREATE TABLE IF NOT EXISTS exams (
  id CHAR(36) PRIMARY KEY,
  data_json LONGTEXT NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  updated_at VARCHAR(30) NOT NULL,
  INDEX exams_updated_at_idx (updated_at)
) ENGINE=InnoDB;