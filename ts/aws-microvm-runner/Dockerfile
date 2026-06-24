FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y \
    python3 \
    python3-pip \
    tar \
    gzip \
    git \
    patch \
    findutils \
    shadow-utils \
    util-linux \
  && dnf clean all

USER root
RUN mkdir -p /workspace /testbed /tests /solution /logs /tmp/tb

WORKDIR /opt/code-sandbox-bench
COPY server.py .

EXPOSE 8080
CMD ["python3", "/opt/code-sandbox-bench/server.py"]
