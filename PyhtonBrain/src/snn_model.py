import torch


class FlyBrainSNN:

    def __init__(self, weight_matrix, device, dt=0.01, tau=0.05):
        self.device = device
        self.W = weight_matrix
        self.num_neurons = self.W.shape[0]
        self.dt = dt
        self.tau = tau

        # Estado de voltaje de las 700 neuronas
        self.V = torch.zeros(
            (self.num_neurons, 1), dtype=torch.float32, device=self.device
        )

    def step(self, external_inputs=None):
        if external_inputs is None:
            external_inputs = torch.zeros_like(self.V)

        # Multiplicación matricial W * V para calcular sinapsis
        synaptic_input = torch.matmul(self.W, self.V)

        # Dinámica Leaky Integrate-and-Fire / ReLU
        dV = (-self.V + torch.relu(synaptic_input + external_inputs)) / self.tau
        self.V = self.V + dV * self.dt
        self.V = torch.clamp(self.V, 0.0, 1.0)

        return self.V


if __name__ == "__main__":
    from build_network import build_pytorch_network

    W, dev = build_pytorch_network()
    brain = FlyBrainSNN(W, dev)
    v_out = brain.step()
    print(
        f"[✓] Modelo SNN de {brain.num_neurons} neuronas operativo. Actividad inicial promedio: {v_out.mean().item():.4f}"
    )