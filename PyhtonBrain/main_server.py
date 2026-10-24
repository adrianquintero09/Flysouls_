import asyncio
import json
from pathlib import Path
import sys
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn
import os
import torch

# Configurar rutas para importar desde src/
CURRENT_DIR = Path(__file__).resolve().parent
SRC_DIR = CURRENT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.append(str(SRC_DIR))

from build_network import build_pytorch_network
from snn_model import FlyBrainSNN

app = FastAPI(title="Fly Souls Boss Brain 700N Backend")

print("==========================================")
print("   INICIALIZANDO CONECTOMA (700 NEURONAS) ")
print("==========================================")

FLYSRC_DIR = CURRENT_DIR.parent

possible_paths = [
    FLYSRC_DIR / "data" / "processed" / "W1_500neurons.npy",
    FLYSRC_DIR / "data" / "processed" / "W500_neurons.npy",
    CURRENT_DIR / "data" / "processed" / "W1_500neurons.npy",
    CURRENT_DIR / "W1_500neurons.npy",
    # Fallback
    FLYSRC_DIR / "data" / "processed" / "W1_100neurons.npy",
]

W_path = None
for path in possible_paths:
    if path.exists():
        W_path = path
        break

if W_path is None:
    raise FileNotFoundError(
        "[!] Error crítico: No se encontró el archivo de matriz de 700 neuronas en Flysrc/data/processed/."
    )

print(f"[✓] Conectoma cargado correctamente desde: {W_path}")

# Cargar pesos y crear red neuronal espicular
W, device = build_pytorch_network(str(W_path))
brain = FlyBrainSNN(W, device)

# Variables de estado
player_position = {"x": 0.0, "z": 0.0}
pain_stimulus_active = 0.0  # Nivel de descarga de dolor al ser golpeado


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global player_position, pain_stimulus_active
    await websocket.accept()
    print("[✓] Cliente Web conectado al Cerebro de 700 Neuronas vía WebSocket.")

    try:
        step_count = 0
        while True:
            # 1. Recoger datos/eventos enviados por el juego (posición o dolor por golpe)
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=0.005)
                message = json.loads(data)
                
                if "player_pos" in message:
                    player_position = message["player_pos"]
                
                # Evento de dolor enviado cuando el jugador asesta un golpe al jefe
                if message.get("type") == "boss_hit" or message.get("event") == "boss_hit":
                    pain_stimulus_active = 6.0  # Descarga agresiva e inmediata
            except asyncio.TimeoutError:
                pass

            # 2. Generar estímulo dinámico de alta agresividad (700 neuronas)
            distancia = (
                player_position["x"] ** 2 + player_position["z"] ** 2
            ) ** 0.5
            
            # Factor de estímulo aumentado (de 2.0 a 4.0) para un jefe más agresivo
            factor_estimulo = max(0.2, 4.0 / (1.0 + distancia))
            estimulo_externo = torch.rand_like(brain.V) * factor_estimulo

            # Inyectar pulso de dolor si el jefe acaba de ser golpeado
            if pain_stimulus_active > 0:
                descarga_dolor = torch.rand_like(brain.V) * pain_stimulus_active
                estimulo_externo += descarga_dolor
                pain_stimulus_active = max(0.0, pain_stimulus_active - 0.6)  # Disipación progresiva

            # 3. Paso de simulación SNN
            V_state = brain.step(external_inputs=estimulo_externo)
            actividad_media = V_state.mean().item()

            step_count += 1
            if step_count % 50 == 0:
                print(
                    f"[Paso {step_count} - 700N] Actividad media: {actividad_media:.4f} | Distancia: {distancia:.2f}"
                )

            # 4. Enviar payload de estado al frontend
            payload = {
                "step": step_count,
                "mean_activity": actividad_media,
                "boss_action_trigger": (
                    float(V_state[0].item()) if len(V_state) > 0 else 0.0
                ),
            }

            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(0.016)  # ~60 FPS

    except WebSocketDisconnect:
        print("[!] Cliente web desconectado.")
    except Exception as e:
        print(f"[!] Error en el servidor WebSocket: {e}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main_server:app", host="0.0.0.0", port=port)