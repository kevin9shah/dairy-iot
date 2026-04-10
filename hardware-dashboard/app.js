const btnConnect = document.getElementById('btnConnect');
const btnSimulate = document.getElementById('btnSimulate');
const tempValue = document.getElementById('tempValue');
const humValue = document.getElementById('humValue');
const statusValue = document.getElementById('statusValue');
const statusIconSvg = document.getElementById('statusIconSvg');
const logContainer = document.getElementById('logContainer');
const particlesContainer = document.getElementById('particles');

let port;
let reader;
let simulatorInterval = null;

// ==================== UI UPDATE LOGIC ====================
function updateDashboard(temp, hum, status) {
  // Update Values
  if (temp !== null) tempValue.textContent = temp.toFixed(1);
  if (hum !== null) humValue.textContent = hum.toFixed(1);
  statusValue.textContent = status;

  // Clear previous theme
  document.body.classList.remove('theme-safe', 'theme-warning', 'theme-danger');

  // Set Theme and Icon based on status
  let themeClass = '';
  let svgContent = '';

  if (status.includes('SAFE')) {
    themeClass = 'theme-safe';
    svgContent = '<circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path>';
  } else if (status.includes('WARN')) {
    themeClass = 'theme-warning';
    svgContent = '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>';
  } else if (status.includes('DANGER')) {
    themeClass = 'theme-danger';
    svgContent = '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>';
  }

  if (themeClass) document.body.classList.add(themeClass);
  statusIconSvg.innerHTML = svgContent;

  addLogEntry(`T:${temp?.toFixed(1) || '--'}C H:${hum?.toFixed(1) || '--'}% Status: ${status}`, themeClass.replace('theme-', ''));
}

function addLogEntry(message, type) {
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  div.textContent = `[${time}] ${message}`;
  
  logContainer.prepend(div);
  
  // Keep only last 50 logs
  if (logContainer.children.length > 50) {
    logContainer.removeChild(logContainer.lastChild);
  }
}

// ==================== PARTICLES ANIMATION ====================
function createParticle() {
  const particle = document.createElement('div');
  particle.classList.add('particle');
  
  // Random size between 2px and 8px
  const size = Math.random() * 6 + 2;
  particle.style.width = `${size}px`;
  particle.style.height = `${size}px`;
  
  // Random position horizontally
  particle.style.left = `${Math.random() * 100}vw`;
  
  // Random animation duration between 5s and 15s
  const duration = Math.random() * 10 + 5;
  particle.style.animationDuration = `${duration}s`;
  
  // Random delay
  particle.style.animationDelay = `${Math.random() * 5}s`;
  
  particlesContainer.appendChild(particle);
  
  // Remove after animation completes to avoid DOM buildup
  setTimeout(() => {
    particle.remove();
  }, (duration + 5) * 1000);
}

// Create new particles periodically
setInterval(createParticle, 500);

// Initial burst of particles
for(let i=0; i<20; i++) {
  setTimeout(createParticle, Math.random() * 2000);
}

// ==================== SERIAL COMMUNICATION ====================
async function connectSerial() {
  if (!('serial' in navigator)) {
    alert("Web Serial API is not supported in your browser. Please use Chrome or Edge.");
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 }); // Match ESP32 baudrate

    btnConnect.textContent = "Disconnect";
    btnConnect.classList.replace('primary', 'secondary');
    btnSimulate.disabled = true;

    stopSimulation();
    
    addLogEntry("Connected to ESP32 Serial Port", "safe");

    // Start reading loop
    readSerialLoop();

  } catch (err) {
    console.error('Error connecting to serial', err);
    addLogEntry(`Connection Error: ${err.message}`, "danger");
  }
}

async function disconnectSerial() {
  if (reader) {
    await reader.cancel();
  }
  if (port) {
    await port.close();
  }
  
  btnConnect.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect ESP32 (USB)`;
  btnConnect.classList.replace('secondary', 'primary');
  btnSimulate.disabled = false;
  addLogEntry("Disconnected from Serial Port", "warning");
}

async function readSerialLoop() {
  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  reader = textDecoder.readable.getReader();

  let partialLine = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        partialLine += value;
        let lines = partialLine.split('\n');
        
        // Keep the last partial string
        partialLine = lines.pop();

        for (let line of lines) {
          parseSerialLine(line.trim());
        }
      }
    }
  } catch (error) {
    console.error("Reader error", error);
    addLogEntry(`Reader Error: ${error.message}`, "danger");
  } finally {
    reader.releaseLock();
  }
}

function parseSerialLine(line) {
  if (!line) return;
  
  // Expected format: "T:25.40C H:60.50% Status: SAFE"
  // Let's use regex to extract the values
  const regex = /T:([\d.]+)C\s+H:([\d.]+)%\s+Status:\s+(.+)/i;
  const match = line.match(regex);

  if (match) {
    const temp = parseFloat(match[1]);
    const hum = parseFloat(match[2]);
    const status = match[3].trim().toUpperCase();
    updateDashboard(temp, hum, status);
  } else {
    // If it's a random print statement like "Scanning for I2C devices..."
    addLogEntry(`SERIAL: ${line}`, "offline");
  }
}

// ==================== SIMULATOR ====================
let simTemp = 4.0;
let simHum = 60.0;
let simTime = 0;

function startSimulation() {
  btnSimulate.textContent = "Stop Simulation";
  btnSimulate.classList.add('primary');
  btnSimulate.classList.remove('secondary');
  btnConnect.disabled = true;
  
  addLogEntry("Starting Simulation Mode", "warning");

  simulatorInterval = setInterval(() => {
    simTime++;
    
    // Simulate a slow heating up scenarios
    if (simTime % 20 < 10) {
      // Safe zone (cooling)
      simTemp -= 0.1;
      simHum += 0.2;
    } else if (simTime % 40 < 30) {
      // Warning zone (warming up)
      simTemp += 0.3;
      simHum -= 0.1;
    } else {
      // Danger zone (spoiling)
      simTemp += 0.5;
      simHum -= 0.3;
    }

    // Clamp values
    if (simTemp < 0) simTemp = 0.5;
    if (simTemp > 10) simTemp = 8.5;
    if (simHum < 30) simHum = 30;
    if (simHum > 90) simHum = 90;

    // Simulate ESP32 Evaluation Logic for COW MILK (0-4C Safe, >4 Danger ...)
    let status = "SAFE";
    if (simTemp > 4.5 || simHum > 75) status = "DANGER";
    else if (simTemp > 4.0 || simTemp < 0 || simHum < 50 || simHum > 70) status = "WARNING";

    updateDashboard(simTemp, simHum, status);
  }, 2000); // Send data every 2 seconds matching the Arduino DELAY
}

function stopSimulation() {
  if (simulatorInterval) {
    clearInterval(simulatorInterval);
    simulatorInterval = null;
  }
  btnSimulate.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Simulate Data`;
  btnSimulate.classList.add('secondary');
  btnSimulate.classList.remove('primary');
  btnConnect.disabled = false;
  addLogEntry("Simulation Stopped", "warning");
  document.body.classList.remove('theme-safe', 'theme-warning', 'theme-danger');
  updateDashboard(null, null, "OFFLINE");
}

// ==================== EVENT LISTENERS ====================
btnConnect.addEventListener('click', () => {
  if (port) {
    disconnectSerial();
  } else {
    connectSerial();
  }
});

btnSimulate.addEventListener('click', () => {
  if (simulatorInterval) {
    stopSimulation();
  } else {
    startSimulation();
  }
});