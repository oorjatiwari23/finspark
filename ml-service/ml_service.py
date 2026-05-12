"""
FeatureIQ Machine Learning Service
Real ML algorithms for churn prediction, anomaly detection, and segmentation
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier, IsolationForest
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
import pickle
import os
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)

# Global variables for models
churn_model = None
scaler = StandardScaler()
kmeans_model = None
anomaly_model = None

class MLService:
    def __init__(self):
        self.models_dir = 'ml_models'
        if not os.path.exists(self.models_dir):
            os.makedirs(self.models_dir)
    
    def prepare_churn_data(self, events_data):
        """
        Prepare features for churn prediction
        """
        df = pd.DataFrame(events_data)
        
        # Feature engineering
        features = df.groupby('tenant_id').agg({
            'event_type': 'count',
            'feature_name': lambda x: x.nunique(),
            'session_id': lambda x: x.nunique(),
            'timestamp': [
                lambda x: (datetime.now().timestamp() * 1000 - x.max()) / (1000 * 60 * 60 * 24),
                lambda x: x.max() - x.min()
            ]
        }).reset_index()
        
        features.columns = ['tenant_id', 'total_events', 'features_used', 
                           'unique_sessions', 'days_inactive', 'activity_span']
        
        features['events_per_session'] = features['total_events'] / (features['unique_sessions'] + 1)
        features['avg_features_per_event'] = features['features_used'] / (features['total_events'] + 1)
        
        return features
    
    def train_churn_model(self, events_data):
        """
        Train Random Forest model for churn prediction
        """
        print("🤖 Training Churn Prediction Model...")
        
        features_df = self.prepare_churn_data(events_data)
        
        # Create synthetic labels - ensure we have BOTH classes
        features_df['churned'] = 0
        
        # Sort by engagement and label bottom 40% as churned
        features_df = features_df.sort_values('total_events')
        churn_count = max(1, int(len(features_df) * 0.4))
        features_df.iloc[:churn_count, features_df.columns.get_loc('churned')] = 1
        
        # Also mark very inactive as churned
        features_df.loc[features_df['days_inactive'] > 5, 'churned'] = 1
        
        # Ensure at least some not churned
        if features_df['churned'].sum() == len(features_df):
            features_df.iloc[-1, features_df.columns.get_loc('churned')] = 0
        
        # Ensure at least some churned
        if features_df['churned'].sum() == 0:
            features_df.iloc[0, features_df.columns.get_loc('churned')] = 1
        
        X = features_df[[
            'total_events', 'features_used', 'unique_sessions',
            'days_inactive', 'events_per_session', 'avg_features_per_event'
        ]].fillna(0)
        
        y = features_df['churned']
        
        # Check class distribution
        print(f"   Class distribution: Churned={y.sum()}, Not Churned={len(y)-y.sum()}")
        
        # Train-test split
        if len(X) < 5:
            X_train, X_test = X, X
            y_train, y_test = y, y
        else:
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=0.2, random_state=42, stratify=y if len(np.unique(y)) > 1 else None
            )
        
        # Scale features
        global scaler
        X_train_scaled = scaler.fit_transform(X_train)
        X_test_scaled = scaler.transform(X_test)
        
        # Train Random Forest
        global churn_model
        churn_model = RandomForestClassifier(
            n_estimators=100,
            max_depth=10,
            random_state=42,
            min_samples_split=2,
            class_weight='balanced'
        )
        
        churn_model.fit(X_train_scaled, y_train)
        
        # Calculate accuracy
        test_accuracy = churn_model.score(X_test_scaled, y_test)
        
        # Feature importance
        feature_importance = dict(zip(X.columns, churn_model.feature_importances_))
        
        # Save model
        with open(f'{self.models_dir}/churn_model.pkl', 'wb') as f:
            pickle.dump(churn_model, f)
        with open(f'{self.models_dir}/scaler.pkl', 'wb') as f:
            pickle.dump(scaler, f)
        
        print(f"✅ Model trained! Accuracy: {test_accuracy:.2%}")
        
        return {
            'status': 'trained',
            'algorithm': 'Random Forest Classifier',
            'test_accuracy': round(test_accuracy * 100, 2),
            'feature_importance': {k: round(v, 4) for k, v in feature_importance.items()},
            'samples_trained': len(X_train),
            'class_distribution': {
                'churned': int(y.sum()),
                'not_churned': int(len(y) - y.sum())
            }
        }
    
    def predict_churn(self, events_data):
        """
        Predict churn probability for each customer
        """
        global churn_model
        
        if churn_model is None:
            return {'error': 'Model not trained yet'}
        
        features_df = self.prepare_churn_data(events_data)
        
        X = features_df[[
            'total_events', 'features_used', 'unique_sessions',
            'days_inactive', 'events_per_session', 'avg_features_per_event'
        ]].fillna(0)
        
        X_scaled = scaler.transform(X)
        
        # Predict
        predictions = churn_model.predict(X_scaled)
        
        # Get probabilities - handle single class case
        proba = churn_model.predict_proba(X_scaled)
        
        if proba.shape[1] == 1:
            churn_probabilities = proba[:, 0] if churn_model.classes_[0] == 1 else (1 - proba[:, 0])
        else:
            churn_probabilities = proba[:, 1]
        
        # Create results
        results = []
        for idx, row in features_df.iterrows():
            churn_prob = churn_probabilities[idx] * 100
            
            results.append({
                'tenant_id': row['tenant_id'],
                'churn_probability': round(churn_prob, 2),
                'will_churn': bool(predictions[idx]),
                'risk_level': 'high' if churn_prob > 70 else 'medium' if churn_prob > 40 else 'low',
                'features': {
                    'total_events': int(row['total_events']),
                    'features_used': int(row['features_used']),
                    'days_inactive': round(row['days_inactive'], 1),
                    'engagement_score': round(row['events_per_session'], 2)
                }
            })
        
        return {
            'predictions': results,
            'model': 'Random Forest',
            'algorithm': 'Ensemble Learning'
        }
    
    def train_clustering(self, events_data):
        """
        K-Means clustering for customer segmentation
        """
        print("🤖 Training Customer Segmentation Model...")
        
        features_df = self.prepare_churn_data(events_data)
        
        X = features_df[[
            'total_events', 'features_used', 'unique_sessions', 'days_inactive'
        ]].fillna(0)
        
        X_scaled = scaler.fit_transform(X)
        
        # K-Means clustering
        global kmeans_model
        kmeans_model = KMeans(n_clusters=min(3, len(features_df)), random_state=42, n_init=10)
        clusters = kmeans_model.fit_predict(X_scaled)
        
        # Analyze clusters
        features_df['cluster'] = clusters
        cluster_analysis = []
        
        for cluster_id in range(min(3, len(features_df))):
            cluster_data = features_df[features_df['cluster'] == cluster_id]
            if len(cluster_data) > 0:
                cluster_analysis.append({
                    'cluster_id': int(cluster_id),
                    'size': len(cluster_data),
                    'avg_events': round(cluster_data['total_events'].mean(), 2),
                    'avg_features': round(cluster_data['features_used'].mean(), 2),
                    'label': self.label_cluster(cluster_data)
                })
        
        # Save model
        with open(f'{self.models_dir}/kmeans_model.pkl', 'wb') as f:
            pickle.dump(kmeans_model, f)
        
        print("✅ Clustering model trained!")
        
        return {
            'status': 'trained',
            'algorithm': 'K-Means Clustering',
            'n_clusters': len(cluster_analysis),
            'clusters': cluster_analysis
        }
    
    def label_cluster(self, cluster_data):
        """Label clusters based on characteristics"""
        avg_events = cluster_data['total_events'].mean()
        if avg_events > 100:
            return 'Power Users'
        elif avg_events > 50:
            return 'Active Users'
        else:
            return 'At-Risk Users'
    
    def detect_anomalies(self, events_data):
        """
        Isolation Forest for anomaly detection
        Detects unusual usage patterns
        """
        try:
            print("🤖 Running Anomaly Detection...")
            
            df = pd.DataFrame(events_data)
            
            if len(df) < 10:
                return {
                    'error': 'Need at least 10 events for anomaly detection',
                    'anomalies': []
                }
            
            # Prepare features for anomaly detection
            # 1. Per-tenant anomalies
            tenant_features = df.groupby('tenant_id').agg({
                'event_type': 'count',
                'feature_name': lambda x: x.nunique(),
                'session_id': lambda x: x.nunique(),
                'timestamp': lambda x: (datetime.now().timestamp() * 1000 - x.min()) / (1000 * 60 * 60)
            }).reset_index()
            
            tenant_features.columns = ['tenant_id', 'event_count', 'unique_features', 'sessions', 'hours_since_first']
            
            # 2. Per-feature anomalies
            feature_usage = df.groupby('feature_name').size().reset_index(name='usage_count')
            
            # 3. Temporal anomalies (hourly usage)
            df['hour'] = pd.to_datetime(df['timestamp'], unit='ms').dt.hour
            hourly_usage = df.groupby('hour').size()
            
            # Train Isolation Forest
            global anomaly_model
            
            # Detect tenant anomalies
            if len(tenant_features) >= 2:
                X_tenant = tenant_features[['event_count', 'unique_features', 'sessions']].fillna(0)
                
                anomaly_model = IsolationForest(
                    contamination=0.3,  # Expect 30% to be anomalies
                    random_state=42,
                    n_estimators=100
                )
                
                tenant_features['anomaly'] = anomaly_model.fit_predict(X_tenant)
                tenant_features['anomaly_score'] = anomaly_model.score_samples(X_tenant)
                
                # Get anomalies (anomaly = -1 means anomaly)
                anomalies = tenant_features[tenant_features['anomaly'] == -1].copy()
            else:
                anomalies = pd.DataFrame()
            
            # Detect feature anomalies (usage spikes)
            feature_mean = feature_usage['usage_count'].mean()
            feature_std = feature_usage['usage_count'].std()
            
            if feature_std > 0:
                feature_usage['z_score'] = (feature_usage['usage_count'] - feature_mean) / feature_std
                unusual_features = feature_usage[abs(feature_usage['z_score']) > 2]
            else:
                unusual_features = pd.DataFrame()
            
            # Detect temporal anomalies
            hourly_mean = hourly_usage.mean()
            hourly_std = hourly_usage.std()
            
            if hourly_std > 0:
                hourly_z = (hourly_usage - hourly_mean) / hourly_std
                unusual_hours = hourly_z[abs(hourly_z) > 2]
            else:
                unusual_hours = pd.Series()
            
            # Compile results
            results = []
            
            # Tenant anomalies
            for idx, row in anomalies.iterrows():
                severity = 'high' if row['anomaly_score'] < -0.5 else 'medium'
                
                # Determine what's unusual
                reasons = []
                avg_events = tenant_features['event_count'].mean()
                if row['event_count'] > avg_events * 2:
                    reasons.append(f"Extremely high activity ({int(row['event_count'])} events, {int((row['event_count']/avg_events - 1)*100)}% above average)")
                elif row['event_count'] < avg_events * 0.3:
                    reasons.append(f"Unusually low activity ({int(row['event_count'])} events, {int((1 - row['event_count']/avg_events)*100)}% below average)")
                
                if row['unique_features'] < 2:
                    reasons.append(f"Limited feature exploration (only {int(row['unique_features'])} features)")
                
                if row['sessions'] == 1:
                    reasons.append("Single session usage pattern")
                
                results.append({
                    'type': 'Tenant Behavior',
                    'entity': row['tenant_id'],
                    'severity': severity,
                    'anomaly_score': round(float(row['anomaly_score']), 3),
                    'description': ' • '.join(reasons) if reasons else 'Unusual usage pattern detected',
                    'metrics': {
                        'events': int(row['event_count']),
                        'features': int(row['unique_features']),
                        'sessions': int(row['sessions'])
                    }
                })
            
            # Feature anomalies
            for idx, row in unusual_features.iterrows():
                severity = 'high' if abs(row['z_score']) > 3 else 'medium'
                
                if row['z_score'] > 0:
                    desc = f"Usage spike detected - {int((row['z_score'] - 1) * 100)}% above normal"
                else:
                    desc = f"Usage drop detected - {int(abs(row['z_score']) * 100)}% below normal"
                
                results.append({
                    'type': 'Feature Usage',
                    'entity': row['feature_name'],
                    'severity': severity,
                    'anomaly_score': round(float(row['z_score']), 3),
                    'description': desc,
                    'metrics': {
                        'usage': int(row['usage_count']),
                        'average': round(feature_mean, 1)
                    }
                })
            
            # Temporal anomalies
            for hour, z_score in unusual_hours.items():
                severity = 'medium'
                
                if z_score > 0:
                    desc = f"Unusual spike at {hour}:00 - {int(z_score * 100)}% above normal"
                else:
                    desc = f"Unusual drop at {hour}:00 - {int(abs(z_score) * 100)}% below normal"
                
                results.append({
                    'type': 'Temporal Pattern',
                    'entity': f"{hour}:00 - {hour+1}:00",
                    'severity': severity,
                    'anomaly_score': round(float(z_score), 3),
                    'description': desc,
                    'metrics': {
                        'events': int(hourly_usage[hour]),
                        'average': round(hourly_mean, 1)
                    }
                })
            
            # Sort by severity
            severity_order = {'high': 0, 'medium': 1, 'low': 2}
            results.sort(key=lambda x: (severity_order.get(x['severity'], 3), abs(x['anomaly_score'])), reverse=True)
            
            print(f"✅ Detected {len(results)} anomalies")
            
            return {
                'algorithm': 'Isolation Forest',
                'total_events': len(df),
                'anomalies_detected': len(results),
                'anomalies': results[:20]  # Return top 20
            }
            
        except Exception as e:
            print(f"❌ Error in anomaly detection: {str(e)}")
            return {
                'error': f'Anomaly detection failed: {str(e)}',
                'anomalies': []
            }

# Initialize ML service
ml_service = MLService()

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'FeatureIQ ML Service',
        'models_loaded': {
            'churn': churn_model is not None,
            'clustering': kmeans_model is not None,
            'anomaly': anomaly_model is not None
        }
    })

@app.route('/train/churn', methods=['POST'])
def train_churn():
    """Train churn prediction model"""
    data = request.json
    events = data.get('events', [])
    
    if len(events) < 10:
        return jsonify({'error': 'Need at least 10 events to train model'}), 400
    
    result = ml_service.train_churn_model(events)
    return jsonify(result)

@app.route('/predict/churn', methods=['POST'])
def predict_churn():
    """Predict churn for customers"""
    data = request.json
    events = data.get('events', [])
    
    result = ml_service.predict_churn(events)
    return jsonify(result)

@app.route('/train/clustering', methods=['POST'])
def train_clustering():
    """Train customer segmentation model"""
    data = request.json
    events = data.get('events', [])
    
    result = ml_service.train_clustering(events)
    return jsonify(result)

@app.route('/detect/anomalies', methods=['POST'])
def detect_anomalies():
    """Detect usage anomalies"""
    data = request.json
    events = data.get('events', [])
    
    result = ml_service.detect_anomalies(events)
    return jsonify(result)

@app.route('/model/info', methods=['GET'])
def model_info():
    """Get information about loaded models"""
    return jsonify({
        'churn_model': {
            'loaded': churn_model is not None,
            'algorithm': 'Random Forest Classifier',
            'type': 'Supervised Learning - Classification'
        },
        'clustering_model': {
            'loaded': kmeans_model is not None,
            'algorithm': 'K-Means',
            'type': 'Unsupervised Learning - Clustering'
        },
        'anomaly_detection': {
            'algorithm': 'Isolation Forest',
            'type': 'Unsupervised Learning - Anomaly Detection'
        }
    })

if __name__ == '__main__':
    print("="*60)
    print("🤖 FeatureIQ Machine Learning Service")
    print("="*60)
    print("Algorithms:")
    print("  - Random Forest: Churn Prediction")
    print("  - K-Means: Customer Segmentation")
    print("  - Isolation Forest: Anomaly Detection")
    print("="*60)
    app.run(host='0.0.0.0', port=5000, debug=True)
