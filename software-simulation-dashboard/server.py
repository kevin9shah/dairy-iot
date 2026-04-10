from flask import Flask, request

app = Flask(__name__)

latest_data = {}

@app.route('/data', methods=['POST'])
def receive_data():
    global latest_data
    latest_data = request.json
    return {"status": "ok"}

@app.route('/get')
def get_data():
    return latest_data

app.run(host="0.0.0.0", port=5000)