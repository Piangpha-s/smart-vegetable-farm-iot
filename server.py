from flask import Flask, request, jsonify, send_from_directory
from pymongo import MongoClient
from datetime import datetime

app = Flask(__name__)

# 🔗 เชื่อมต่อ MongoDB ในเครื่อง
client = MongoClient("mongodb://localhost:27017/")
db = client["smart_farm"]       # ชื่อฐานข้อมูล
plants_collection = db["plants"]   # เก็บข้อมูลพืช
plants_collection.create_index("name", unique=True)
sensors_collection = db["sensor_logs"] # เก็บข้อมูลเซนเซอร์
watering_logs_collection = db["watering_logs"]


# เก็บค่าจาก ESP32
sensor_data = {
    "temperature": 0,
    "distance": 0,
    "light": 0,
    "soilMoisture": 0
}

# เก็บสถานะการควบคุม (สำหรับให้ ESP32 มาอ่าน)
control_state = {
    "water": 0,   # 0=ปิด, 1=เปิด (GPIO 27 - ปั๊มน้ำ)
    "light": 0,   # 0=ปิด, 1=เปิด (GPIO 25 - ไฟ)
    "fan": 0,      # 0=ปิด, 1=เปิด (GPIO 26 - พัดลม)
        "lastLightOn": None
}

# Route สำหรับอัปเดตค่าจาก ESP32
@app.route("/update", methods=["GET"])
def update_data():
    temp = request.args.get("temperature", type=float)
    dist = request.args.get("distance", type=float)
    light = request.args.get("light", type=float)
    soil = request.args.get("soil", type=float) 

    print("Received => temp:", temp, "dist:", dist, "light:", light, "soil:", soil)

    if temp is not None:
        sensor_data["temperature"] = temp
    if dist is not None:
        sensor_data["distance"] = dist
    if light is not None:
        sensor_data["light"] = light
    if soil is not None:   
        sensor_data["soilMoisture"] = soil

    # ✅ บันทึกค่าจริงลง MongoDB
    sensors_collection.insert_one({
        "timestamp": datetime.now(),
        **sensor_data
    })

    print("📦 บันทึกข้อมูลเซนเซอร์สำเร็จ:", sensor_data)
    return jsonify(sensor_data)


# Route สำหรับดึงข้อมูล JSON
@app.route("/data")
def get_data():
    return jsonify({
        **sensor_data,
        "ts": datetime.now().isoformat(),
        "lastLightOn": control_state.get("lastLightOn")
    })


# หน้าเว็บจะยิง POST มาที่นี่เมื่อกดปุ่มเปิดปิด
@app.route("/control", methods=["POST"])
def control():
    data = request.get_json() or {}

    if "water" in data:
        control_state["water"] = int(data["water"])

    if "light" in data:
        prev = int(control_state.get("light", 0))
        newv = int(data["light"])
        control_state["light"] = newv
        if newv == 1 and prev == 0:
            control_state["lastLightOn"] = datetime.now().isoformat()

    if "fan" in data:
        control_state["fan"] = int(data["fan"])

    print("🎛️ Updated control state:", control_state)
    return jsonify(control_state)

system_mode = {"mode": "auto"}


@app.route("/system_mode", methods=["POST"])
def set_system_mode():
    data = request.get_json(silent=True) or {}
    mode = data.get("mode", "auto")
    if mode not in ("auto","manual"):
        return jsonify({"message":"invalid mode"}), 400
    system_mode["mode"] = mode
    print("🔄 เปลี่ยนโหมดระบบเป็น:", mode)   # เพิ่มบรรทัดนี้
    return jsonify(system_mode), 200



# หน้า dashboard.html
@app.route("/")
def index():
    return send_from_directory('dashboard', 'dashboard.html')


# Static route สำหรับไฟล์ CSS/JS ภายในโฟลเดอร์ dashboard
@app.route("/dashboard/<path:filename>")
def dashboard_static(filename):
    return send_from_directory('dashboard', filename)


@app.route("/get_control", methods=["GET"])
def get_control():
    # ✅ ดึงพืชตัวแรก (หรือที่กำลังใช้งาน)
    plant = plants_collection.find_one({}, {"_id": 0})
    mode = system_mode.get("mode", "auto")

    if not plant:
        return jsonify({**control_state, "mode": mode})

    # ✅ ดึงค่าโหมดและช่วงค่าความชื้นในดิน
    target_soil_str = plant.get("soilMoistureRange", "60–80%").replace("%", "")
    try:
        min_soil, max_soil = map(int, target_soil_str.split("–"))
    except Exception:
        min_soil = max_soil = int(''.join(filter(str.isdigit, target_soil_str)) or 60)

    interval = int(plant.get("wateringInterval", 6))
    hour = datetime.now().hour

    # ✋ โหมดแมนนวล → ส่งค่าที่ผู้ใช้กดจากหน้าเว็บโดยตรง
    if mode == "manual":
        print("🧠 โหมดรดน้ำ: manual | ใช้ค่าจาก control_state:", control_state)
        return jsonify({**control_state, "mode": "manual"})

    # 🧠 โหมดอัตโนมัติ (ตามค่าความชื้น)
    if mode == "auto":
        if sensor_data["soilMoisture"] < min_soil:
            control_state["water"] = 1
        elif sensor_data["soilMoisture"] > max_soil:
            control_state["water"] = 0

    # 🕒 โหมดตามช่วงเวลา
    elif mode == "scheduled":
        control_state["water"] = 1 if (hour % interval == 0) else 0

    print(f"🧠 โหมดรดน้ำ: {mode} | ความชื้นดิน: {sensor_data['soilMoisture']}% "
          f"| ช่วงเป้าหมาย: {min_soil}–{max_soil}% | เปิดน้ำ: {control_state['water']}")
    
    return jsonify({**control_state, "mode": mode})


#เพิ่ม Route สำหรับจัดการ “พืช”
@app.route("/plants", methods=["POST"])
def add_plant():
    data = request.get_json()
    name = data.get("name")

    if not name:
        return jsonify({"message": "ไม่มีชื่อพืช"}), 400

    if plants_collection.find_one({"name": name}):
        return jsonify({"message": f"พืช '{name}' มีอยู่แล้ว"}), 400

    plants_collection.insert_one(data)
    return jsonify({"message": f"เพิ่มพืช '{name}' เรียบร้อย"}), 201

@app.route("/plants/<name>", methods=["PUT"])
def update_plant(name):
    data = request.get_json()
    new_name = data.get("name")

    # ถ้าเปลี่ยนชื่อ → ตรวจว่าไม่ชนกับชื่ออื่น
    if new_name and new_name != name:
        if plants_collection.find_one({"name": new_name}):
            return jsonify({"message": f"ชื่อพืช '{new_name}' มีอยู่แล้ว"}), 400

        # ✅ เปลี่ยนชื่อก่อน
        plants_collection.update_one({"name": name}, {"$set": {"name": new_name}})
        name = new_name  # ✅ ใช้ชื่อใหม่ในการอัปเดต field อื่น

    # ✅ อัปเดต field อื่น
    update_data = data.copy()
    update_data.pop("name", None)

    result = plants_collection.update_one({"name": name}, {"$set": update_data})

    if result.matched_count == 0:
        return jsonify({"message": f"ไม่พบพืชชื่อ '{name}'"}), 404

    return jsonify({"message": f"แก้ไขพืช '{name}' สำเร็จ"}), 200

@app.route("/plants", methods=["GET"])
def get_plants():
    plants = list(plants_collection.find({}, {"_id": 0}))
    return jsonify(plants)


@app.route("/log_watering", methods=["POST"])
def log_watering():
    data = request.get_json()
    plant_name = data.get("plantName")
    timestamp = datetime.now()

    if not plant_name:
        return jsonify({"message": "ไม่มีชื่อพืช"}), 400

    watering_logs_collection.insert_one({
        "plantName": plant_name,
        "timestamp": timestamp
    })

    plants_collection.update_one(
        {"name": plant_name},
        {"$set": {"lastWateredTime": timestamp}}
    )

    print(f"📝 บันทึกการรดน้ำ: {plant_name} @ {timestamp}")
    return jsonify({"message": "บันทึกการรดน้ำสำเร็จ"}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)