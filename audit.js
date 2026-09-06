const fs = require("fs");
const path = require("path");
const { db, useSqlite } = require("./db");

const LOGS_DIR = path.join(__dirname, "logs");
const AUDIT_LOG_FILE = path.join(LOGS_DIR, "audit.log");

if (!fs.existsSync(LOGS_DIR)) {
    try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (_) {}
}

class AuditService {
    constructor() {
        this.memoryLogs = [];
        this.maxMemoryLogs = 2000;
    }

    registrar({
        event_type,
        usuario = "",
        status = "INFO",
        duration_ms = 0,
        details = {},
        ip = "",
        userAgent = ""
    }) {
        const now = Date.now();
        const iso = new Date(now).toISOString();
        const local = new Date(now).toLocaleString("pt-BR");

        const logEntry = {
            id: null,
            timestamp: local,
            iso,
            event_type,
            usuario: (usuario || "").trim(),
            status,
            duration_ms: Number(Number(duration_ms).toFixed(2)),
            details: typeof details === "object" ? details : { raw: details },
            ip: ip || "",
            user_agent: userAgent || "",
            created_at: now
        };

        // 1. Gravação no SQLite
        if (useSqlite && db) {
            try {
                const stmt = db.prepare(`
                    INSERT INTO audit_logs (timestamp, event_type, usuario, status, duration_ms, details, ip, user_agent, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const info = stmt.run(
                    local,
                    event_type,
                    logEntry.usuario,
                    status,
                    logEntry.duration_ms,
                    JSON.stringify(logEntry.details),
                    logEntry.ip,
                    logEntry.user_agent,
                    now
                );
                logEntry.id = Number(info.lastInsertRowid);
            } catch (err) {
                console.error("[AUDIT] Erro ao gravar no SQLite:", err.message);
            }
        }

        // 2. Gravação em arquivo append-only (JSONL)
        try {
            const line = JSON.stringify(logEntry) + "\n";
            fs.appendFileSync(AUDIT_LOG_FILE, line, "utf8");
        } catch (err) {
            console.error("[AUDIT] Erro ao gravar audit.log:", err.message);
        }

        // 3. Cache em memória para acesso ultrarrápido
        this.memoryLogs.unshift(logEntry);
        if (this.memoryLogs.length > this.maxMemoryLogs) {
            this.memoryLogs.pop();
        }

        const durationTag = duration_ms > 0 ? ` [⚡ ${(duration_ms / 1000).toFixed(2)}s]` : "";
        console.log(`[AUDIT] [${event_type}] [${status}] ${logEntry.usuario}${durationTag} - ${JSON.stringify(details)}`);

        return logEntry;
    }

    listar({ limit = 100, offset = 0, usuario = "", event_type = "", status = "" } = {}) {
        if (useSqlite && db) {
            try {
                let sql = "SELECT * FROM audit_logs WHERE 1=1";
                const params = [];

                if (usuario) {
                    sql += " AND lower(usuario) LIKE ?";
                    params.push(`%${usuario.toLowerCase().trim()}%`);
                }
                if (event_type) {
                    sql += " AND event_type = ?";
                    params.push(event_type);
                }
                if (status) {
                    sql += " AND status = ?";
                    params.push(status);
                }

                sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
                params.push(Number(limit), Number(offset));

                const rows = db.prepare(sql).all(...params);
                return rows.map(r => ({
                    ...r,
                    details: (() => {
                        try { return JSON.parse(r.details); } catch (_) { return {}; }
                    })()
                }));
            } catch (err) {
                console.error("[AUDIT] Erro ao listar logs do SQLite:", err.message);
            }
        }

        // Fallback memória
        return this.memoryLogs.slice(offset, offset + limit);
    }

    obterEstatisticas() {
        if (useSqlite && db) {
            try {
                const totalLogs = db.prepare("SELECT count(*) as count FROM audit_logs").get().count;
                const statsValidacao = db.prepare(`
                    SELECT 
                        count(*) as total,
                        avg(duration_ms) as avg_duration,
                        min(duration_ms) as min_duration,
                        max(duration_ms) as max_duration
                    FROM audit_logs 
                    WHERE duration_ms > 0 AND event_type IN ('VALIDATION_RESULT', 'VALIDATION_SUCCESS', 'VALIDATION_FAILED', 'VALIDATION_WORKER')
                `).get();

                const statusCounts = db.prepare(`
                    SELECT status, count(*) as count 
                    FROM audit_logs 
                    GROUP BY status
                `).all();

                const eventosRecentes = db.prepare(`
                    SELECT event_type, count(*) as count 
                    FROM audit_logs 
                    GROUP BY event_type
                `).all();

                return {
                    totalLogs,
                    totalValidacoes: statsValidacao.total || 0,
                    avgDuracaoMs: Math.round(statsValidacao.avg_duration || 0),
                    avgDuracaoSegundos: Number(((statsValidacao.avg_duration || 0) / 1000).toFixed(2)),
                    minDuracaoSegundos: Number(((statsValidacao.min_duration || 0) / 1000).toFixed(2)),
                    maxDuracaoSegundos: Number(((statsValidacao.max_duration || 0) / 1000).toFixed(2)),
                    statusCounts,
                    eventosRecentes
                };
            } catch (err) {
                console.error("[AUDIT] Erro ao obter estatísticas:", err.message);
            }
        }

        return {
            totalLogs: this.memoryLogs.length,
            totalValidacoes: 0,
            avgDuracaoMs: 0,
            avgDuracaoSegundos: 0
        };
    }

    limpar() {
        this.memoryLogs = [];
        if (useSqlite && db) {
            try {
                db.exec("DELETE FROM audit_logs;");
            } catch (_) {}
        }
        try {
            if (fs.existsSync(AUDIT_LOG_FILE)) {
                fs.writeFileSync(AUDIT_LOG_FILE, "", "utf8");
            }
        } catch (_) {}
        return true;
    }
}

const auditService = new AuditService();
module.exports = auditService;
