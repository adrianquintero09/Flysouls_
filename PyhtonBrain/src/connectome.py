from pathlib import Path
import pandas as pd
import numpy as np

FLYSRC_DIR = Path(__file__).resolve().parent.parent.parent

DATA_RAW_DIR = FLYSRC_DIR / "data" / "raw"
DATA_PROCESSED_DIR = FLYSRC_DIR / "data" / "processed"


def get_processed_weights(filename="W1_700neurons.npy"):
    file_path = Path(filename)
    
    # Si la ruta proporcionada no es absoluta, buscar en DATA_PROCESSED_DIR
def get_processed_weights(filename="W1_500neurons.npy"):
    file_path = Path(filename)
    
    if not file_path.is_absolute() or not file_path.exists():
        file_path = DATA_PROCESSED_DIR / filename.split("/")[-1]

    if not file_path.exists():
        raise FileNotFoundError(f"[!] Error: No se encontró el archivo de pesos en {file_path}")

    weights = np.load(file_path)
    print(f"[✓] Pesos cargados correctamente desde: {file_path} | Matriz: {weights.shape}")
    return weights


def load_raw_csv(filename):
    file_path = DATA_RAW_DIR / filename
    if not file_path.exists():
        raise FileNotFoundError(f"[!] Error: No se encontró el archivo en {file_path}")

    df = pd.read_csv(file_path, compression="gzip")
    print(f"[✓] Archivo '{filename}' cargado correctamente. Registros: {len(df):,}")
    return df


if __name__ == "__main__":
    print("[+] Comprobando conectoma de 700 neuronas...")
    try:
        w = get_processed_weights("W1_700neurons.npy")
    except Exception as e:
        print(e)