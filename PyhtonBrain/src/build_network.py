import sys
from pathlib import Path
import torch

SRC_DIR = Path(__file__).resolve().parent
if str(SRC_DIR) not in sys.path:
    sys.path.append(str(SRC_DIR))

from connectome import get_processed_weights


def build_pytorch_network(weight_filename="W1_500neurons.npy", device=None):
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    w_numpy = get_processed_weights(weight_filename)
    w_tensor = torch.tensor(w_numpy, dtype=torch.float32, device=device)

    print(
        f"[+] Red neuronal de {w_tensor.shape[0]} neuronas inicializada en PyTorch ({device})."
    )
    return w_tensor, device

if __name__ == "__main__":
    W, dev = build_pytorch_network()
    print(f"Tensor de pesos listo con forma: {W.shape}")