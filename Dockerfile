FROM python:3.7.0


ADD server.py /
ADD static /
ADD templates /
ADD requirements.txt /

RUN pip install --requirement requirements.txt

ENTRYPOINT [ "python", "./server.py" ]